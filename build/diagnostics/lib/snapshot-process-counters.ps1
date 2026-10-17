# Opt-in Windows diagnostic helper. Never waits for, polls, signals, or kills a
# measured process. Input/output are bounded fixed-field JSONL, not PowerShell
# object serialization. The caller must drain both stdout and stderr.
param([switch]$SelfTest)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$script:handles = @{}
$script:seen = @{}
$script:registered = 0
$script:completed = 0
$script:unknown = 0
$script:protocolErrors = 0
$script:cleanupErrors = 0
$script:outputFailed = $false
$script:maxHandles = 128
$script:maxIdentities = 4096
$script:controlRecords = New-Object 'System.Collections.Generic.List[object]'

function Write-Record($record) {
    if ($SelfTest) { $script:controlRecords.Add($record); return }
    if ($script:outputFailed) { return }
    try {
        [Console]::Out.WriteLine(($record | ConvertTo-Json -Compress -Depth 3))
        [Console]::Out.Flush()
    } catch { $script:outputFailed = $true }
}

function Write-Unknown($id, [string]$reason) {
    $script:unknown++
    Write-Record ([ordered]@{ version = 1; event = 'unknown'; id = $id; reason = $reason })
}

try {
    # Standard Add-Type / PInvoke; no downloaded assemblies, compilation output,
    # shell evaluation, privilege changes, or per-target helper processes.
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace HfmSnapshotCounters {
    [StructLayout(LayoutKind.Sequential)]
    public struct FileTime {
        public uint Low;
        public uint High;
        public ulong Value { get { return ((ulong)High << 32) | Low; } }
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct IoCounters {
        public ulong ReadOperations;
        public ulong WriteOperations;
        public ulong OtherOperations;
        public ulong ReadBytes;
        public ulong WriteBytes;
        public ulong OtherBytes;
    }
    public sealed class ProcessHandle : SafeHandleZeroOrMinusOneIsInvalid {
        public bool ReleaseSucceeded = true;
        public ProcessHandle() : base(true) { }
        public static ProcessHandle Open(uint pid) {
            ProcessHandle handle = Native.OpenProcess(0x00101000, false, pid);
            if (handle == null) return null;
            if (handle.IsInvalid) { handle.Dispose(); return null; }
            return handle;
        }
        protected override bool ReleaseHandle() {
            ReleaseSucceeded = Native.CloseHandle(handle);
            return ReleaseSucceeded;
        }
    }
    public sealed class InputLine {
        public string Text;
        public bool TooLong;
    }
    public static class Native {
        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern ProcessHandle OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint pid);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint WaitForSingleObject(ProcessHandle handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool GetProcessTimes(ProcessHandle handle, out FileTime created,
            out FileTime exited, out FileTime kernel, out FileTime user);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool GetProcessIoCounters(ProcessHandle handle, out IoCounters counters);

        // ReadLine() would allocate an unbounded string before validation.
        // This consumes a stream; blocking for input is not process polling.
        public static InputLine ReadBoundedLine(TextReader reader) {
            StringBuilder buffer = new StringBuilder(256);
            bool overflow = false;
            bool any = false;
            for (;;) {
                int value = reader.Read();
                if (value < 0) return any ? new InputLine { Text = buffer.ToString(), TooLong = overflow } : null;
                any = true;
                if (value == 10) return new InputLine { Text = buffer.ToString().TrimEnd('\r'), TooLong = overflow };
                if (!overflow) {
                    if (buffer.Length < 1024) buffer.Append((char)value);
                    else { overflow = true; buffer.Length = 0; }
                }
            }
        }
        public static string Decimal(ulong value) {
            return value.ToString(System.Globalization.CultureInfo.InvariantCulture);
        }
    }
}
'@ -ErrorAction Stop | Out-Null
} catch {
    if ($SelfTest) {
        [Console]::Out.WriteLine('{"version":1,"event":"self-test","ok":false,"reason":"observer-init-failed"}')
        exit 1
    }
    Write-Unknown $null 'observer-init-failed'
    exit 1
}

function Is-Integer($value, [ulong]$maximum) {
    if ($null -eq $value -or $value -is [bool] -or $value -is [string]) { return $false }
    if ($value -isnot [int] -and $value -isnot [long] -and $value -isnot [uint32] -and $value -isnot [ulong]) { return $false }
    return $value -ge 0 -and $value -le $maximum
}

function Has-Keys($message, [string[]]$expected) {
    if ($null -eq $message -or $message -is [array] -or $message -is [string]) { return $false }
    $actual = @($message.PSObject.Properties.Name)
    if ($actual.Count -ne $expected.Count) { return $false }
    foreach ($key in $expected) { if ($actual -cnotcontains $key) { return $false } }
    return $true
}

function Close-Owned($entry) {
    try {
        $entry.handle.Dispose()
        if (-not $entry.handle.ReleaseSucceeded) { $script:cleanupErrors++; return $false }
        return $true
    } catch { $script:cleanupErrors++; return $false }
}

function Read-Times($handle) {
    $created = New-Object HfmSnapshotCounters.FileTime
    $exited = New-Object HfmSnapshotCounters.FileTime
    $kernel = New-Object HfmSnapshotCounters.FileTime
    $user = New-Object HfmSnapshotCounters.FileTime
    if (-not [HfmSnapshotCounters.Native]::GetProcessTimes($handle, [ref]$created, [ref]$exited, [ref]$kernel, [ref]$user)) { return $null }
    return @{ created = $created.Value; exited = $exited.Value; kernel = $kernel.Value; user = $user.Value }
}

function Register-Target($message) {
    $key = [string]$message.id
    if ($script:seen.ContainsKey($key)) { $script:protocolErrors++; Write-Unknown $message.id 'duplicate-id'; return }
    if ($script:seen.Count -ge $script:maxIdentities) { Write-Unknown $message.id 'identity-cap'; return }
    $script:seen[$key] = 'rejected'
    if ($script:handles.Count -ge $script:maxHandles) { Write-Unknown $message.id 'handle-cap'; return }
    $handle = $null
    $retained = $false
    try {
        $handle = [HfmSnapshotCounters.ProcessHandle]::Open([uint32]$message.pid)
        if ($null -eq $handle) { Write-Unknown $message.id 'open-failed'; return }
        $times = Read-Times $handle
        if ($null -eq $times) { Write-Unknown $message.id 'times-failed'; return }
        if ([HfmSnapshotCounters.Native]::Decimal($times.created) -cne $message.creationFileTime) {
            Write-Unknown $message.id 'identity-mismatch'; return
        }
        $wait = [HfmSnapshotCounters.Native]::WaitForSingleObject($handle, 0)
        if ($wait -eq 0) { Write-Unknown $message.id 'already-exited'; return }
        if ($wait -ne 258) { Write-Unknown $message.id 'wait-failed'; return }
        $script:handles[$key] = @{ handle = $handle; id = $message.id; pid = $message.pid; creationFileTime = $message.creationFileTime }
        $retained = $true
        $script:seen[$key] = 'active'
        $script:registered++
    } catch { Write-Unknown $message.id 'observer-failed' }
    finally {
        if ($null -ne $handle -and -not $retained) { $null = Close-Owned @{ handle = $handle } }
    }
}

function Complete-Target($id) {
    $key = [string]$id
    if (-not $script:handles.ContainsKey($key)) {
        # Register and close travel without an acknowledgement barrier. A close
        # after rejected registration consumes no second terminal record.
        if ($script:seen[$key] -eq 'rejected') { return }
        $script:protocolErrors++
        Write-Unknown $id 'not-registered'
        return
    }
    $entry = $script:handles[$key]
    $script:handles.Remove($key)
    $script:seen[$key] = 'completed'
    $record = $null
    $reason = $null
    try {
        $wait = [HfmSnapshotCounters.Native]::WaitForSingleObject($entry.handle, 0)
        if ($wait -eq 258) { $reason = 'process-not-exited' }
        elseif ($wait -ne 0) { $reason = 'wait-failed' }
        else {
            $times = Read-Times $entry.handle
            if ($null -eq $times) { $reason = 'times-failed' }
            elseif ([HfmSnapshotCounters.Native]::Decimal($times.created) -cne $entry.creationFileTime) { $reason = 'identity-mismatch' }
            elseif ($times.exited -eq 0) { $reason = 'exit-time-unavailable' }
            else {
                $io = New-Object HfmSnapshotCounters.IoCounters
                if (-not [HfmSnapshotCounters.Native]::GetProcessIoCounters($entry.handle, [ref]$io)) { $reason = 'io-failed' }
                else {
                    # Lifetime cumulative CPU and all logical process I/O.
                    # Neither backup-only cost nor physical disk/lock evidence.
                    $record = [ordered]@{ version = 1; event = 'result'; id = $id; pid = $entry.pid
                        creationFileTime = $entry.creationFileTime
                        exitFileTime = [HfmSnapshotCounters.Native]::Decimal($times.exited)
                        kernelTime100ns = [HfmSnapshotCounters.Native]::Decimal($times.kernel)
                        userTime100ns = [HfmSnapshotCounters.Native]::Decimal($times.user)
                        readOperations = [HfmSnapshotCounters.Native]::Decimal($io.ReadOperations)
                        writeOperations = [HfmSnapshotCounters.Native]::Decimal($io.WriteOperations)
                        otherOperations = [HfmSnapshotCounters.Native]::Decimal($io.OtherOperations)
                        readBytes = [HfmSnapshotCounters.Native]::Decimal($io.ReadBytes)
                        writeBytes = [HfmSnapshotCounters.Native]::Decimal($io.WriteBytes)
                        otherBytes = [HfmSnapshotCounters.Native]::Decimal($io.OtherBytes) }
                }
            }
        }
    } catch { $reason = 'observer-failed' }
    finally { if (-not (Close-Owned $entry)) { $reason = 'close-failed' } }
    if ($null -ne $reason) { Write-Unknown $id $reason }
    else { $script:completed++; Write-Record $record }
}

function Close-AllTargets {
    foreach ($key in @($script:handles.Keys)) {
        $entry = $script:handles[$key]
        $script:handles.Remove($key)
        $script:seen[$key] = 'completed'
        $closed = Close-Owned $entry
        if ($closed) { Write-Unknown $entry.id 'unfinished' }
        else { Write-Unknown $entry.id 'close-failed' }
    }
}

if ($SelfTest) {
    # Windows-only wiring controls, before the measured fixture. The only
    # process this mode may stop is its own synthetic stdin-blocked child.
    # Cleanup controls call the exact function used by both finish and EOF;
    # they are not a claim that those transport boundaries were exercised.
    $child = $null
    $controlHandle = $null
    $ok = $false
    $checks = New-Object 'System.Collections.Generic.List[string]'
    try {
        $child = New-Object System.Diagnostics.Process
        $child.StartInfo.FileName = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
        $child.StartInfo.Arguments = '-NoLogo -NoProfile -NonInteractive -Command "[Console]::In.ReadLine() | Out-Null"'
        $child.StartInfo.UseShellExecute = $false
        $child.StartInfo.CreateNoWindow = $true
        $child.StartInfo.RedirectStandardInput = $true
        $child.StartInfo.RedirectStandardOutput = $true
        $child.StartInfo.RedirectStandardError = $true
        if (-not $child.Start()) { throw 'control-failed' }
        $stdoutDrain = $child.StandardOutput.ReadToEndAsync()
        $stderrDrain = $child.StandardError.ReadToEndAsync()
        $controlHandle = [HfmSnapshotCounters.ProcessHandle]::Open([uint32]$child.Id)
        if ($null -eq $controlHandle) { throw 'control-failed' }
        $times = Read-Times $controlHandle
        if ($null -eq $times -or $times.created -eq 0) { throw 'control-failed' }
        $creation = [HfmSnapshotCounters.Native]::Decimal($times.created)
        $wrongCreation = [HfmSnapshotCounters.Native]::Decimal(($times.created + [ulong]1))
        if (-not (Close-Owned @{ handle = $controlHandle })) { throw 'control-failed' }
        $controlHandle = $null

        Register-Target ([pscustomobject]@{ id = 1; pid = $child.Id; creationFileTime = $wrongCreation })
        if ($script:handles.Count -ne 0 -or $script:controlRecords[-1].reason -cne 'identity-mismatch') { throw 'control-failed' }
        $checks.Add('mismatched-identity-rejected')
        Register-Target ([pscustomobject]@{ id = 2; pid = $child.Id; creationFileTime = $creation })
        if ($script:handles.Count -ne 1) { throw 'control-failed' }
        Complete-Target 2
        if ($script:handles.Count -ne 0 -or $script:controlRecords[-1].reason -cne 'process-not-exited' -or $child.HasExited) { throw 'control-failed' }
        $checks.Add('live-target-refused-without-termination')

        foreach ($id in @(3, 4, 5)) { Register-Target ([pscustomobject]@{ id = $id; pid = $child.Id; creationFileTime = $creation }) }
        if ($script:handles.Count -ne 3) { throw 'control-failed' }
        $child.StandardInput.WriteLine('exit')
        $child.StandardInput.Close()
        if (-not $child.WaitForExit(5000)) { throw 'control-failed' }
        if ($child.ExitCode -ne 0) { throw 'control-failed' }
        Complete-Target 3
        $sample = $script:controlRecords[-1]
        if ($sample.event -cne 'result' -or $sample.creationFileTime -cne $creation -or $script:handles.Count -ne 2) { throw 'control-failed' }
        foreach ($field in @('creationFileTime', 'exitFileTime', 'kernelTime100ns', 'userTime100ns', 'readOperations', 'writeOperations', 'otherOperations', 'readBytes', 'writeBytes', 'otherBytes')) {
            if ($sample[$field] -isnot [string] -or $sample[$field] -cnotmatch '^(0|[1-9][0-9]{0,19})$') { throw 'control-failed' }
        }
        $checks.Add('retained-handle-final-counters-readable')

        # The two handles retained before exit exercise the shared cleanup path.
        if ($script:handles.Count -ne 2) { throw 'control-failed' }
        Close-AllTargets
        if ($script:handles.Count -ne 0 -or $script:cleanupErrors -ne 0 -or $script:controlRecords[-1].reason -cne 'unfinished') { throw 'control-failed' }
        $checks.Add('finish-eof-shared-cleanup-function')
        $ok = $true
    } catch { $ok = $false }
    finally {
        Close-AllTargets
        if ($null -ne $controlHandle) { if (-not (Close-Owned @{ handle = $controlHandle })) { $ok = $false } }
        if ($null -ne $child) {
            try {
                if (-not $child.HasExited) {
                    # Exclusive ownership: this is only the synthetic child
                    # created above, never any measured snapshot process.
                    $child.Kill()
                    if (-not $child.WaitForExit(5000)) { $ok = $false }
                }
                $child.Dispose()
            } catch { $ok = $false }
        }
        if ($script:cleanupErrors -ne 0 -or $script:handles.Count -ne 0) { $ok = $false }
    }
    [Console]::Out.WriteLine(([ordered]@{ version = 1; event = 'self-test'; ok = $ok; checks = @($checks.ToArray())
        cleanupErrors = $script:cleanupErrors; openHandles = $script:handles.Count } | ConvertTo-Json -Compress -Depth 3))
    if ($ok) { exit 0 }
    exit 1
}

$failed = $false
Write-Record ([ordered]@{ version = 1; event = 'ready' })
try {
    while (-not $script:outputFailed) {
        $line = [HfmSnapshotCounters.Native]::ReadBoundedLine([Console]::In)
        if ($null -eq $line) { break }
        if ($line.TooLong) { $script:protocolErrors++; Write-Unknown $null 'line-too-long'; continue }
        if ($line.Text -cnotmatch '^\s*\{.*\}\s*$') {
            $script:protocolErrors++; Write-Unknown $null 'invalid-message'; continue
        }
        $message = $null
        try { $message = $line.Text | ConvertFrom-Json -ErrorAction Stop } catch { }
        # Reject duplicate/escaped JSON keys as well as extra fields; normal
        # JSON conversion alone can silently discard duplicate keys.
        $keys = [regex]::Matches($line.Text, '"([^"\\]*(?:\\.[^"\\]*)*)"\s*:')
        $propertyNames = @($message.PSObject.Properties.Name)
        $duplicateKeys = $keys.Count -ne $propertyNames.Count
        foreach ($match in $keys) { if ($propertyNames -cnotcontains $match.Groups[1].Value) { $duplicateKeys = $true } }
        if ($null -eq $message -or $duplicateKeys -or -not (Is-Integer $message.version 1) -or $message.version -ne 1) {
            $script:protocolErrors++; Write-Unknown $null 'invalid-message'; continue
        }
        if ($message.action -ceq 'finish' -and (Has-Keys $message @('version', 'action'))) { break }
        if (-not (Is-Integer $message.id 9007199254740991) -or $message.id -eq 0) {
            $script:protocolErrors++; Write-Unknown $null 'invalid-message'; continue
        }
        if ($message.action -ceq 'close' -and (Has-Keys $message @('version', 'action', 'id'))) { Complete-Target $message.id; continue }
        $creation = [ulong]0
        if ($message.action -ceq 'register' -and (Has-Keys $message @('version', 'action', 'id', 'pid', 'creationFileTime')) `
            -and (Is-Integer $message.pid 4294967295) -and $message.pid -gt 0 `
            -and $message.creationFileTime -is [string] -and $message.creationFileTime -cmatch '^[1-9][0-9]{0,19}$' `
            -and [ulong]::TryParse($message.creationFileTime, [ref]$creation)) {
            Register-Target $message; continue
        }
        $script:protocolErrors++; Write-Unknown $message.id 'invalid-message'
    }
} catch { $failed = $true; Write-Unknown $null 'observer-failed' }
finally {
    Close-AllTargets
    Write-Record ([ordered]@{ version = 1; event = 'finished'; registered = $script:registered
        completed = $script:completed; unknown = $script:unknown; openHandles = $script:handles.Count
        cleanupErrors = $script:cleanupErrors; protocolErrors = $script:protocolErrors })
}
if ($failed -or $script:outputFailed -or $script:cleanupErrors -gt 0) { exit 1 }
exit 0
