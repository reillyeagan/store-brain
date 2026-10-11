# Adds only APPROVAL_SIGNING_KEY. Generated on this PC, never shown, never saved.
$chars = 'abcdefghijkmnpqrstuvwxyz23456789'.ToCharArray()
$bytes = New-Object byte[] 48
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$key = -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
$tmp = Join-Path $env:TEMP ('sb-' + [guid]::NewGuid().ToString() + '.json')
try {
  [System.IO.File]::WriteAllText($tmp, '{"APPROVAL_SIGNING_KEY":"' + $key + '"}')
  & npx --yes wrangler@4 secret bulk $tmp
} finally { if (Test-Path $tmp) { Remove-Item $tmp -Force } }
Write-Host ''
Write-Host '  Done. The approval signing key was added. Nothing to save.' -ForegroundColor Green
