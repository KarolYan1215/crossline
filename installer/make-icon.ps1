<#
  Draws the app icon (the PWA icon's design, apps/web/app/pwa-icon: a white "C" on ink over the five line colours) at the sizes
  Windows uses and writes them as one .ico with PNG-compressed entries. Used by scripts/package-installer.ts for the tray exe and the
  installer.
#>
param([Parameter(Mandatory = $true)][string]$Out)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$lines = @('#1F5FA8', '#A8551F', '#7A3FA0', '#1E7A4C', '#8A6D1F')
$pngs = @()
foreach ($size in 256, 64, 48, 32, 16) {
  $bitmap = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bitmap)
  $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'
  $g.Clear([System.Drawing.ColorTranslator]::FromHtml('#0A0A0A'))
  $bar = [Math]::Max(2, [Math]::Round($size * 0.1))
  $width = $size / $lines.Count
  for ($i = 0; $i -lt $lines.Count; $i++) {
    $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($lines[$i]))
    $g.FillRectangle($brush, [float]($i * $width), [float]($size - $bar), [float]($width + 1), [float]$bar)
    $brush.Dispose()
  }
  $font = New-Object System.Drawing.Font 'Arial', ([float]($size * 0.62)), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $format = New-Object System.Drawing.StringFormat
  $format.Alignment = 'Center'; $format.LineAlignment = 'Center'
  $g.DrawString('C', $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF 0, 0, $size, ($size - $bar)), $format)
  $g.Dispose()
  $stream = New-Object System.IO.MemoryStream
  $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
  $pngs += , @{ Size = $size; Bytes = $stream.ToArray() }
}
$ico = New-Object System.IO.MemoryStream
$writer = [System.IO.BinaryWriter]::new($ico)
$writer.Write([UInt16]0); $writer.Write([UInt16]1); $writer.Write([UInt16]$pngs.Count)
$offset = 6 + 16 * $pngs.Count
foreach ($png in $pngs) {
  $dim = if ($png.Size -ge 256) { 0 } else { $png.Size }
  $writer.Write([byte]$dim); $writer.Write([byte]$dim); $writer.Write([byte]0); $writer.Write([byte]0)
  $writer.Write([UInt16]1); $writer.Write([UInt16]32); $writer.Write([UInt32]$png.Bytes.Length); $writer.Write([UInt32]$offset)
  $offset += $png.Bytes.Length
}
foreach ($png in $pngs) { $writer.Write($png.Bytes) }
$writer.Flush()
[System.IO.File]::WriteAllBytes($Out, $ico.ToArray())
