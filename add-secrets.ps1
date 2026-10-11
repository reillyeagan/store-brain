# Store Brain - add one or more secrets to Cloudflare from hidden input.
# Usage (from a .bat): add-secrets.ps1 -Spec "NAME|prompt|regex;NAME2|prompt2|regex2"
# Values are hidden as you paste, checked for shape, sent to Cloudflare in one go, and the
# temporary file is deleted. Claude never sees them.
param([string]$Spec)

function Read-Hidden([string]$prompt) {
  $sec = Read-Host -Prompt $prompt -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try { return ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)).Trim() }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

$pairs = @()
Write-Host ''
Write-Host '  Paste each value and press Enter. Nothing shows while you paste - that is normal.'
Write-Host ''
foreach ($item in $Spec.Split(';')) {
  $parts = $item.Split('|')
  $name = $parts[0]; $prompt = $parts[1]; $rx = $parts[2]
  $val = Read-Hidden ('  ' + $prompt)
  if ($val -notmatch $rx) {
    Write-Host ''
    Write-Host ('  That ' + $name + " doesn't look right. Nothing was saved - run this file again.") -ForegroundColor Red
    exit 1
  }
  $pairs += ('"' + $name + '":"' + $val.Replace('\','\\').Replace('"','\"') + '"')
}

$tmp = Join-Path $env:TEMP ('sb-' + [guid]::NewGuid().ToString() + '.json')
try {
  [System.IO.File]::WriteAllText($tmp, '{' + ($pairs -join ',') + '}')
  Write-Host ''
  Write-Host '  Adding to Cloudflare...'
  & npx --yes wrangler@4 secret bulk $tmp
  $ok = ($LASTEXITCODE -eq 0)
} finally { if (Test-Path $tmp) { Remove-Item $tmp -Force } }

Write-Host ''
if ($ok) { Write-Host '  Done. Saved in Cloudflare. Nothing to save on your side.' -ForegroundColor Green }
else { Write-Host '  Something went wrong. Nothing was saved - run this file again.' -ForegroundColor Red }
