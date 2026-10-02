@echo off
rem MeshyFixer GUI starter - double-click this file. No Blender install needed
rem if you unpacked a portable Blender build into fixer\blender-portable\
cd /d "%~dp0"
python roblox_fix.py --gui
if errorlevel 1 (
  echo.
  echo Python not found - install it from https://www.python.org/downloads/
  echo (tick "Add python.exe to PATH" during setup) and try again.
  pause
)
