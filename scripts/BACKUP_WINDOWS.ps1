$ErrorActionPreference='Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
New-Item -ItemType Directory -Force storage/backups | Out-Null
$stamp=Get-Date -Format 'yyyyMMdd-HHmmss'
$target="storage/backups/attendance-$stamp.sql"
# PowerShell host-side redirection writes the backup without embedding passwords in commands.
cmd /c "docker compose exec -T db sh -c 'pg_dump -U `$POSTGRES_USER -d `$POSTGRES_DB' > $target"
if ($LASTEXITCODE -ne 0) { throw 'Backup failed' }
Write-Host "Database backup: $target (back up storage/uploads separately)"
