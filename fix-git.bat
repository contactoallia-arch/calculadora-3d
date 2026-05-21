@echo off
echo ============================================
echo  Reparando repositorio git de Calculadora
echo ============================================
echo.

cd /d "%~dp0"

echo [1/4] Eliminando .git corrupto...
rd /s /q ".git" 2>nul
echo Hecho.

echo [2/4] Inicializando repositorio limpio...
git init
git branch -M main

echo [3/4] Conectando con GitHub...
git remote add origin https://github.com/contactoallia-arch/calculadora-3d.git

echo [4/4] Sincronizando con repositorio remoto...
git fetch origin
git reset origin/main --mixed

echo.
echo ============================================
echo  Listo! Repo configurado correctamente.
echo  Ahora podés usar "subir-a-vercel.bat"
echo  o el panel Git de VS Code para pushear.
echo ============================================
pause
