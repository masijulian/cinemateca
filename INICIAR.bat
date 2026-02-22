@echo off
title CINEMATECA
color 0A
cls

echo.
echo  =====================================
echo   CINEMATECA - Iniciando...
echo  =====================================
echo.

:: Check Node.js
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo  [ERROR] Node.js no encontrado.
    echo  Descargalo en: https://nodejs.org
    echo.
    pause
    exit /b 1
)

echo  [OK] Node.js encontrado

:: Go to backend
cd /d "%~dp0backend"

:: Install if needed
if not exist "node_modules" (
    echo  Instalando dependencias...
    npm install
    if %ERRORLEVEL% NEQ 0 (
        echo  [ERROR] Fallo npm install
        pause
        exit /b 1
    )
)

echo  [OK] Dependencias listas
echo.
echo  Abriendo CINEMATECA en el navegador...
echo.

:: Open browser after 2 seconds
start "" /b cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:3737"

:: Start server
node server.js

pause
