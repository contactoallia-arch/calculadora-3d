@echo off
echo ============================================
echo  Subiendo cambios a GitHub + Vercel
echo ============================================
echo.

cd /d "%~dp0"

echo Verificando cambios...
git status

echo.
echo Agregando archivos modificados...
git add index.html api\ package.json vercel.json .gitignore logo-original.png logo-transparent.png 2>nul
git add . 2>nul

echo.
set /p MSG=Descripcion del cambio (Enter = "Actualizacion"):
if "%MSG%"=="" set MSG=Actualizacion %date%

git commit -m "%MSG%"

echo.
echo Subiendo a GitHub...
git push origin main

echo.
echo ============================================
echo  Listo! Vercel deployara automaticamente
echo  en ~30 segundos.
echo.
echo  URL: https://calculadora-3d-two.vercel.app
echo ============================================
pause
