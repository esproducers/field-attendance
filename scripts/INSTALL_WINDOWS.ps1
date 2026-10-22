$ErrorActionPreference='Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
if (!(Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker Desktop is required. Install and start Docker Desktop first.' }
docker info *> $null
if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop engine is not running.' }
if (!(Test-Path '.env')) { Copy-Item '.env.example' '.env'; Write-Host 'Created .env. Edit strong database and admin passwords before proceeding.'; notepad .env; exit 1 }
$envText=Get-Content .env -Raw
if ($envText -match 'CHANGE_ME') { throw 'Replace ALL CHANGE_ME placeholders in .env, then rerun this script.' }
New-Item -ItemType Directory -Force storage/uploads,storage/backups | Out-Null
docker compose config --quiet
if ($LASTEXITCODE -ne 0) { throw 'Docker configuration is invalid.' }
docker compose up -d --build
if ($LASTEXITCODE -ne 0) { throw 'Docker startup failed. Run: docker compose logs --tail=100' }
docker compose ps
Write-Host 'Open http://localhost:8080 on this computer.'
