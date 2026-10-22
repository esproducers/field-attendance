@echo off
setlocal EnableExtensions
cd /d "%~dp0"
if not exist "docker-compose.yml" (
 echo ERROR: docker-compose.yml not found next to this BAT file.
 echo Copy START_ADMIN.bat into your field-attendance-v2 project folder.
 pause
 exit /b 1
)
if not exist ".env" (
 echo ERROR: .env not found. Configure your existing project first.
 pause
 exit /b 1
)
echo [1/4] Checking Docker Desktop...
docker info >nul 2>&1
if errorlevel 1 (
 if exist "%ProgramFiles%\Docker\Docker\Docker Desktop.exe" (
  start "" "%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
 ) else (
  echo Docker Desktop not found. Start it manually.
 )
)
set /a tries=0
:wait_docker
docker info >nul 2>&1
if not errorlevel 1 goto docker_ready
set /a tries+=1
if %tries% GEQ 60 (
 echo ERROR: Docker engine did not become ready within 120 seconds.
 pause
 exit /b 1
)
timeout /t 2 /nobreak >nul
goto wait_docker
:docker_ready
echo [2/4] Starting Field Attendance services...
docker compose up -d --build
if errorlevel 1 (
 echo ERROR: Docker Compose failed. Showing status and recent logs.
 docker compose ps -a
 docker compose logs --tail=40
 pause
 exit /b 1
)
echo [3/4] Waiting for the local HTTP health endpoint...
set /a healthtries=0
:wait_health
powershell -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8080/health' -TimeoutSec 3; if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300) {exit 0} else {exit 1} } catch {exit 1}" >nul 2>&1
if not errorlevel 1 goto health_ready
set /a healthtries+=1
if %healthtries% GEQ 45 (
 echo ERROR: Server health check failed after 135 seconds.
 docker compose ps -a
 docker compose logs api --tail=60
 pause
 exit /b 1
)
timeout /t 3 /nobreak >nul
goto wait_health
:health_ready
echo [4/4] Opening admin dashboard...
start "" "http://localhost:8080/"
echo.
echo Field Attendance is running at http://localhost:8080/
echo Closing this window does not stop the Docker services.
echo To stop them later, run: docker compose stop
echo.
pause
exit /b 0
