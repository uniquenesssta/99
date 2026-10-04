$ErrorActionPreference = 'Stop'
# Only the uniquely named, disposable uninstall-native fixture is eligible.
# This runs after a failed assertion and must never turn the acceptance green.
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

public static class FontDispositionProbe {
    [StructLayout(LayoutKind.Sequential)]
    struct IoStatus { public IntPtr Status; public UIntPtr Information; }
    [StructLayout(LayoutKind.Sequential)]
    struct Info {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Modified;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle file, out Info info);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder path, uint length, uint flags);
    [DllImport("ntdll.dll")]
    static extern int NtSetInformationFile(SafeFileHandle file, out IoStatus status, ref uint flags, uint length, uint kind);
    [DllImport("ntdll.dll")]
    static extern uint RtlNtStatusToDosError(int status);

    public static void Run(string target, string expectedHash) {
        string root = Path.GetFullPath(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Microsoft", "Windows", "Fonts"));
        target = Path.GetFullPath(target);
        if (!String.Equals(Path.GetDirectoryName(target), root, StringComparison.OrdinalIgnoreCase)
            || !Regex.IsMatch(Path.GetFileName(target), @"\AHFM_F06_TEST_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_中文\.ttf\z")
            || !Regex.IsMatch(expectedHash ?? "", @"\A[0-9a-f]{64}\z"))
            throw new InvalidOperationException("Probe refused non-fixture target");
        // Match the production open: READ | DELETE, SHARE_READ, OPEN_REPARSE_POINT.
        using (SafeFileHandle file = CreateFileW(target, 0x80010000, 1, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero)) {
            if (file.IsInvalid) { Console.WriteLine("probe open error=" + Marshal.GetLastWin32Error()); return; }
            Info info;
            if (!GetFileInformationByHandle(file, out info)) throw new System.ComponentModel.Win32Exception();
            if (info.Links != 1 || (info.Attributes & (0x10 | 0x400 | 1)) != 0)
                throw new InvalidOperationException("Probe refused links/reparse/directory/readonly target");
            StringBuilder physical = new StringBuilder(32768);
            uint length = GetFinalPathNameByHandleW(file, physical, (uint)physical.Capacity, 0);
            string resolved = physical.ToString();
            if (resolved.StartsWith(@"\\?\")) resolved = resolved.Substring(4);
            if (length == 0 || length >= physical.Capacity || !String.Equals(resolved, target, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Probe refused unresolved path");
            using (FileStream stream = new FileStream(file, FileAccess.Read))
            using (SHA256 sha = SHA256.Create()) {
                string actualHash = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
                if (actualHash != expectedHash) throw new InvalidOperationException("Probe fixture content changed");
                Console.WriteLine("probe fixture attributes=0x" + info.Attributes.ToString("X8") + " volume=" + info.Volume + " fileId=" + info.IndexHigh + ":" + info.IndexLow);
                // First repeat unchanged flags; only if they fail, compare POSIX
                // without FORCE_IMAGE_SECTION_CHECK on this SAME pinned object.
                // Neither attempt ignores readonly, changes ACLs, or requests UAC.
                foreach (uint candidate in new uint[] { 7, 3 }) {
                    uint flags = candidate;
                    IoStatus iosb;
                    int status = NtSetInformationFile(file, out iosb, ref flags, 4, 64);
                    Console.WriteLine("probe flags=0x" + flags.ToString("X2") + " ntstatus=0x" + unchecked((uint)status).ToString("X8") + " win32=" + RtlNtStatusToDosError(status));
                    if (status >= 0) break;
                }
            }
        }
        Console.WriteLine("probe pathPresent=" + File.Exists(target));
    }
}
'@
[FontDispositionProbe]::Run($env:HFM_DISPOSITION_FIXTURE, $env:HFM_DISPOSITION_SHA256)
