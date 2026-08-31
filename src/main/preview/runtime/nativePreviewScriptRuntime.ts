export function buildNativePreviewPowerShellScript(inputPath: string): string {
  return `
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$inputJsonPath = '${inputPath.replaceAll("'", "''")}'
$inputJson = Get-Content -Raw -Encoding UTF8 -LiteralPath $inputJsonPath | ConvertFrom-Json

$fontPath = [string]$inputJson.fontPath
$preferSystemFont = [bool]$inputJson.preferSystemFont
$systemFontFamilyCandidates = @($inputJson.systemFontFamilyCandidates)
$text = [string]$inputJson.text
$fontSize = [float]$inputJson.fontSize
$width = [int]$inputJson.width
$height = [int]$inputJson.height
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
