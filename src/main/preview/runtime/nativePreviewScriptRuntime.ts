import { DEFAULT_PREVIEW_TEXT, PREVIEW_INPUT_LIMITS } from './previewInputPolicy'

// Owns parsing as well as validation. Callers supply the original $inputJsonText,
// because ConvertFrom-Json can replace lone surrogate escapes before inspection.
// Also executable without GDI+ in the native boundary diagnostics.
export function buildPreviewInputPowerShellValidation(): string {
  const limits = PREVIEW_INPUT_LIMITS
  return String.raw`
foreach ($token in [regex]::Matches($inputJsonText, '"(?:\\.|[^"\\])*"')) {
  $raw = $token.Value
  $pendingHigh = $false
  for ($i = 1; $i -lt $raw.Length - 1; $i++) {
    $unit = [int][char]$raw[$i]
    if ($unit -eq 92) {
      $i++
      if ($raw[$i] -ceq 'u') {
        if ($i + 4 -ge $raw.Length - 1) { throw "PREVIEW_INPUT_INVALID: JSON Unicode" }
        $hex = $raw.Substring($i + 1, 4)
        if ($hex -cnotmatch '^[0-9a-fA-F]{4}$') { throw "PREVIEW_INPUT_INVALID: JSON Unicode" }
        $unit = [Convert]::ToInt32($hex, 16)
        $i += 4
      } else {
        # Escaped backslash/quote/control is a non-surrogate code unit. In
        # particular, a literal backslash followed by 'ud800' is valid text.
        $unit = 0
      }
    }
    if ($pendingHigh) {
      if ($unit -lt 0xdc00 -or $unit -gt 0xdfff) { throw "PREVIEW_INPUT_INVALID: JSON Unicode" }
      $pendingHigh = $false
    } elseif ($unit -ge 0xd800 -and $unit -le 0xdbff) {
      $pendingHigh = $true
    } elseif ($unit -ge 0xdc00 -and $unit -le 0xdfff) {
      throw "PREVIEW_INPUT_INVALID: JSON Unicode"
    }
  }
  if ($pendingHigh) { throw "PREVIEW_INPUT_INVALID: JSON Unicode" }
}
$inputJson = ConvertFrom-Json -InputObject $inputJsonText

function Assert-PreviewNumber($value, $min, $max, $integer) {
  if (($value -isnot [int]) -and ($value -isnot [long]) -and ($value -isnot [double]) -and ($value -isnot [decimal])) {
    throw "PREVIEW_INPUT_INVALID: numeric type"
  }
  $number = [double]$value
  if ([double]::IsNaN($number) -or [double]::IsInfinity($number) -or $number -lt $min -or $number -gt $max -or ($integer -and [Math]::Truncate($number) -ne $number)) {
    throw "PREVIEW_INPUT_INVALID: numeric range"
  }
}
Assert-PreviewNumber $inputJson.width ${limits.minWidth} ${limits.maxWidth} $true
Assert-PreviewNumber $inputJson.height ${limits.minHeight} ${limits.maxHeight} $true
Assert-PreviewNumber $inputJson.fontSize ${limits.minFontSize} ${limits.maxFontSize} $false
if ($inputJson.text -isnot [string] -or $inputJson.text.Length -gt ${limits.maxTextLength}) {
  throw "PREVIEW_INPUT_INVALID: text"
}
$text = $inputJson.text
for ($i = 0; $i -lt $text.Length; $i++) {
  if ([char]::IsHighSurrogate($text[$i])) {
    $i++
    if ($i -ge $text.Length -or -not [char]::IsLowSurrogate($text[$i])) { throw "PREVIEW_INPUT_INVALID: text Unicode" }
  } elseif ([char]::IsLowSurrogate($text[$i])) { throw "PREVIEW_INPUT_INVALID: text Unicode" }
}
if ($text.Length -eq 0) { $text = '${DEFAULT_PREVIEW_TEXT}' }
$fontSize = [float]$inputJson.fontSize
$width = [int]$inputJson.width
$height = [int]$inputJson.height
`
}

export function buildNativePreviewPowerShellScript(inputPath: string): string {
  return `
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$inputJsonPath = '${inputPath.replaceAll("'", "''")}'
$inputJsonText = Get-Content -Raw -Encoding UTF8 -LiteralPath $inputJsonPath
${buildPreviewInputPowerShellValidation()}

$fontPath = [string]$inputJson.fontPath
$preferSystemFont = [bool]$inputJson.preferSystemFont
$systemFontFamilyCandidates = @($inputJson.systemFontFamilyCandidates)
$outputPath = [string]$inputJson.outputPath

$pfc = $null
$family = $null
$lastSystemError = $null

if ($preferSystemFont -and $systemFontFamilyCandidates.Count -gt 0) {
  foreach ($candidate in $systemFontFamilyCandidates) {
    $name = ([string]$candidate).Trim()
    if ([string]::IsNullOrWhiteSpace($name)) { continue }
    try {
      $candidateFamily = New-Object System.Drawing.FontFamily($name)
      if ($candidateFamily -ne $null) {
        $family = $candidateFamily
        break
      }
    } catch {
      $lastSystemError = $_.Exception.Message
    }
  }
}

if ($family -eq $null) {
  if ([string]::IsNullOrWhiteSpace($fontPath)) {
    if ($lastSystemError) { throw "System font family not found: $lastSystemError" }
    throw "System font family not found and fontPath is empty."
  }
  $pfc = New-Object System.Drawing.Text.PrivateFontCollection
  $pfc.AddFontFile($fontPath)

  if ($pfc.Families.Count -lt 1) {
    throw "PrivateFontCollection has no font family."
  }

  $family = $pfc.Families[0]
}

$bitmap = New-Object System.Drawing.Bitmap($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$graphics.Clear([System.Drawing.Color]::Transparent)

$fontStyle = [System.Drawing.FontStyle]::Regular
$font = New-Object System.Drawing.Font($family, $fontSize, $fontStyle, [System.Drawing.GraphicsUnit]::Pixel)
$brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(242, 244, 248))
$rect = New-Object System.Drawing.RectangleF(0, 0, $width, $height)
$stringFormat = New-Object System.Drawing.StringFormat
$stringFormat.Trimming = [System.Drawing.StringTrimming]::EllipsisCharacter
$stringFormat.FormatFlags = [System.Drawing.StringFormatFlags]::LineLimit
$stringFormat.Alignment = [System.Drawing.StringAlignment]::Center
$stringFormat.LineAlignment = [System.Drawing.StringAlignment]::Center

$graphics.DrawString($text, $font, $brush, $rect, $stringFormat)

$bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)

$brush.Dispose()
$font.Dispose()
$graphics.Dispose()
$bitmap.Dispose()
if ($pfc -ne $null) { $pfc.Dispose() }
if ($family -ne $null -and ($pfc -eq $null)) { $family.Dispose() }
`
}
