@echo off
echo ===================================================
echo 380V Smart Meter Monitor - Server Startup Script
echo ===================================================

cd /d "%~dp0\backend"

echo [1/3] Checking Python installation...
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Python is not installed or not in PATH! Please install Python 3.9+.
    pause
    exit /b
)

echo [2/3] Installing/Verifying Dependencies...
pip install -r requirements.txt

echo [3/3] Starting Server on Port 3004...
uvicorn main:app --host 0.0.0.0 --port 3004

pause
