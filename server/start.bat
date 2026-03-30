@echo off
title OCPS Validator Server
cd /d %~dp0
echo Installing dependencies...
pip install -r requirements.txt -q
echo.
echo Starting OCPS Validator Server...
python server.py
pause
