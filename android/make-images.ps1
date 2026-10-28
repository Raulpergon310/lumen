# Generates the launcher icon and the Android TV banner (320x180) from build/icon.png.
param([string]$Root = (Split-Path $PSScriptRoot -Parent))
Add-Type -AssemblyName System.Drawing

$icon = [System.Drawing.Image]::FromFile((Join-Path $Root 'build/icon.png'))

function Save-Png($bmp, $path) {
  New-Item -ItemType Directory -Force (Split-Path $path) | Out-Null
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

# Launcher icon 96x96 (xhdpi)
$b = New-Object System.Drawing.Bitmap 96, 96
$g = [System.Drawing.Graphics]::FromImage($b)
$g.InterpolationMode = 'HighQualityBicubic'
$g.DrawImage($icon, 0, 0, 96, 96)
$g.Dispose()
Save-Png $b (Join-Path $PSScriptRoot 'res/mipmap-xhdpi/ic_launcher.png')

# Banner 320x180: dark gradient, icon on the left, name on the right
$b = New-Object System.Drawing.Bitmap 320, 180
$g = [System.Drawing.Graphics]::FromImage($b)
$g.SmoothingMode = 'AntiAlias'
$g.InterpolationMode = 'HighQualityBicubic'
$g.TextRenderingHint = 'AntiAliasGridFit'
$rect = New-Object System.Drawing.Rectangle 0, 0, 320, 180
$bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, ([System.Drawing.Color]::FromArgb(255, 28, 28, 34)), ([System.Drawing.Color]::FromArgb(255, 8, 8, 10)), 35
$g.FillRectangle($bg, $rect)
$g.DrawImage($icon, 28, 42, 96, 96)
$font = New-Object System.Drawing.Font 'Segoe UI Semibold', 34, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
$g.DrawString('Lumen', $font, [System.Drawing.Brushes]::White, 136, 66)
$g.Dispose()
Save-Png $b (Join-Path $PSScriptRoot 'res/drawable/banner.png')

$icon.Dispose()
