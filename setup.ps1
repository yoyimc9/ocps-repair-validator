# setup.ps1  -  Eseguire UNA SOLA VOLTA per generare la chiave di firma e ottenere l'ID dell'estensione.
# Dopo l'esecuzione, aggiungere i due GitHub Secrets come indicato sotto.

$extensionDir = "$PSScriptRoot\extension"
$pemFile      = "$PSScriptRoot\extension.pem"
$chrome       = "C:\Program Files\Google\Chrome\Application\chrome.exe"

if (-not (Test-Path $chrome)) {
    $chrome = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
}
if (-not (Test-Path $chrome)) {
    Write-Error "Chrome not found. Install Chrome or update the path in this script."
    exit 1
}

# -- Passo 1: Impacchetta l'estensione (genera extension.pem + extension.crx) --
Write-Host ""
Write-Host "[1/3] Packing extension..." -ForegroundColor Cyan
& $chrome --pack-extension="$extensionDir" --no-sandbox 2>$null

if (-not (Test-Path "$PSScriptRoot\extension.pem")) {
    Write-Error "extension.pem was not created. Make sure Chrome can write to this folder."
    exit 1
}

Write-Host "    extension.pem  -> created" -ForegroundColor Green
Write-Host "    extension.crx  -> created" -ForegroundColor Green

# -- Passo 2: Codifica in base64 il .pem per il GitHub Secret --
Write-Host ""
Write-Host "[2/3] Encoding extension.pem to base64 (for GitHub Secret)..." -ForegroundColor Cyan
$base64Pem = [Convert]::ToBase64String([IO.File]::ReadAllBytes($pemFile))

$secretFile = "$PSScriptRoot\EXTENSION_PEM_SECRET.txt"
$base64Pem | Set-Content $secretFile -Encoding ASCII
Write-Host "    Saved to: $secretFile" -ForegroundColor Green

# -- Passo 3: Ricordare all'utente di ottenere l'ID estensione da Chrome --
Write-Host ""
Write-Host "[3/3] Get your Extension ID:" -ForegroundColor Cyan
Write-Host "    1. Open chrome://extensions   (Developer mode ON)"
Write-Host "    2. Click 'Load unpacked' and select: $extensionDir"
Write-Host "    3. Copy the ID shown under the extension name"
Write-Host ""

$extId = Read-Host "Paste your Extension ID here"
$extId = $extId.Trim()

Write-Host ""
Write-Host "========================================================" -ForegroundColor Yellow
Write-Host " ADD THESE 2 SECRETS IN YOUR GITHUB REPO:" -ForegroundColor Yellow
Write-Host " (Settings -> Secrets and variables -> Actions -> New secret)" -ForegroundColor Yellow
Write-Host "========================================================" -ForegroundColor Yellow
Write-Host ""
Write-Host "  Secret name : EXTENSION_PEM" -ForegroundColor White
Write-Host "  Secret value: (contents of EXTENSION_PEM_SECRET.txt)" -ForegroundColor Gray
Write-Host ""
Write-Host "  Secret name : EXTENSION_ID" -ForegroundColor White
Write-Host "  Secret value: $extId" -ForegroundColor Gray
Write-Host ""
Write-Host "  (GITHUB_TOKEN is automatic - no action needed)" -ForegroundColor DarkGray
Write-Host ""
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host " ALSO enable GitHub Pages:" -ForegroundColor Cyan
Write-Host "  Repo Settings -> Pages -> Source: Deploy from branch" -ForegroundColor Cyan
Write-Host "  Branch: main, Folder: /docs" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Done! Commit everything, push to GitHub, then release with:" -ForegroundColor Green
Write-Host "  git tag v2.0.0"
Write-Host "  git push origin v2.0.0"
Write-Host ""
