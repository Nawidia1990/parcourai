@echo off
rem ============================================================================
rem  Parcourai - Windows setup
rem
rem    setup.cmd          Full setup: Node.js check, npm install, API keys,
rem                       GitHub, Vercel, then optionally the local dev server.
rem    setup.cmd github   Only the GitHub step (commit and push your code).
rem    setup.cmd vercel   Only the Vercel step (log in, link, upload keys, deploy).
rem    setup.cmd dev      Start the local dev server using the keys already saved.
rem    setup.cmd help     Show this help.
rem
rem  Keys are typed in the console, so they are visible on screen while you type.
rem  They are written to .env.local, which this script also adds to .gitignore so it
rem  is never committed. .env.local only affects your own computer - the Vercel step
rem  can upload the same keys to your Vercel project (Production).
rem ============================================================================
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
title Parcourai setup

set "ENVFILE=%~dp0.env.local"

if /i "%~1"=="dev" goto :devmode
if /i "%~1"=="github" goto :mode_github
if /i "%~1"=="vercel" goto :mode_vercel
if /i "%~1"=="pull" goto :mode_pull
if /i "%~1"=="help" goto :usage
if "%~1"=="/?" goto :usage
if "%~1"=="-h" goto :usage
if "%~1"=="--help" goto :usage

echo ============================================================
echo  Parcourai - local setup
echo ============================================================
echo.

call :check_node
if errorlevel 1 goto :fail

echo [1/6] Installing dependencies...
call npm install
if not errorlevel 1 goto :npm_ok
echo.
echo   npm could not use its cache folder (often a missing drive or a bad npm "cache" setting).
echo   Retrying with a cache folder on drive C for this setup only...
set "npm_config_cache=%LOCALAPPDATA%\parcourai-npm-cache"
if not exist "%npm_config_cache%" mkdir "%npm_config_cache%"
call npm install
if errorlevel 1 goto :npm_failed
:npm_ok

echo.
echo [2/6] Making sure secrets are never committed...
call :ensure_gitignore

echo.
echo [3/6] API keys and secrets
if not exist "%ENVFILE%" goto :do_env
choice /c YN /n /m "A .env.local file already exists. Overwrite it? [Y/N] "
if errorlevel 2 goto :after_env
:do_env
call :write_env
:after_env

echo.
echo [4/6] GitHub
choice /c YN /n /m "Set up GitHub now - commit and push this project? [Y/N] "
if errorlevel 2 goto :skip_github
call :github_setup
:skip_github

echo.
echo [5/6] Vercel - this is the step that puts the new version on your live site
choice /c YN /n /m "Set up Vercel now - log in, link, upload keys, deploy? [Y/N] "
if errorlevel 2 goto :skip_vercel
call :vercel_setup
:skip_vercel

echo.
echo [6/6] Done.
echo.
echo   Run any step again later:  setup.cmd github   setup.cmd vercel   setup.cmd dev
echo.
choice /c YN /n /m "Start the local dev server now? [Y/N] "
if errorlevel 2 goto :end
goto :rundev

rem ---------------------------------------------------------------------------
:mode_github
call :ensure_gitignore
call :github_setup
goto :end

:mode_vercel
call :vercel_setup
goto :end

:mode_pull
call :check_node
if errorlevel 1 goto :fail
echo   Copying every environment variable stored in Vercel (Production) into .env.local ...
call npx --yes vercel whoami >nul 2>&1
if errorlevel 1 call npx --yes vercel login
if not exist ".vercel\project.json" call npx --yes vercel link
if exist "%ENVFILE%" copy /y "%ENVFILE%" "%ENVFILE%.bak" >nul
call npx --yes vercel env pull ".env.local" --environment=production --yes
if errorlevel 1 goto :fail
echo.
echo   Done. Variables marked "sensitive" in Vercel are not returned and show up empty;
echo   type those in with setup.cmd (your previous file was kept as .env.local.bak).
goto :end

:devmode
call :check_node
if errorlevel 1 goto :fail
if not exist "node_modules" goto :not_installed
goto :rundev

:not_installed
echo Dependencies are not installed yet - run setup.cmd without arguments first.
goto :fail

:rundev
echo.
if not exist "%ENVFILE%" goto :no_envfile
call :load_env
goto :start_server
:no_envfile
echo No .env.local found - AI and server features will not work until you run setup.cmd.
:start_server
echo Starting the local dev server. The first run asks you to log in to Vercel and link this project.
echo Open the address it prints - usually http://localhost:3000 - and press Ctrl+C here to stop.
echo.
call npx --yes vercel dev
goto :end

:usage
echo Usage:
echo   setup.cmd          Full setup: dependencies, API keys, GitHub, Vercel
echo   setup.cmd github   Commit and push this project to GitHub
echo   setup.cmd vercel   Log in to Vercel, link the project, upload keys, deploy
echo   setup.cmd pull     Copy every variable already stored in Vercel into .env.local
echo   setup.cmd dev      Start the local dev server using the keys saved in .env.local
exit /b 0

:npm_failed
echo.
echo npm install failed - see the messages above.
echo If it mentions a cache folder, run:  npm config set cache "%LOCALAPPDATA%\npm-cache"  and try again.
echo Also try running setup.cmd from a folder on drive C (for example C:\Parcourai), not from a USB, network or cloud-synced drive.
goto :fail

:fail
echo.
echo Setup did not finish.
pause
exit /b 1

:end
echo.
pause
exit /b 0

rem ---------------------------------------------------------------------------
rem  Subroutines
rem ---------------------------------------------------------------------------

:check_node
where node >nul 2>&1
if errorlevel 1 goto :no_node
node -e "process.exit(Number(process.versions.node.split('.')[0])>=18?0:1)"
if errorlevel 1 goto :old_node
exit /b 0
:no_node
echo Node.js was not found. Install the LTS version from https://nodejs.org and run this again.
exit /b 1
:old_node
echo Node.js 18 or newer is required. Install the current LTS from https://nodejs.org and run this again.
exit /b 1

:ensure_gitignore
if not exist ".gitignore" type nul > ".gitignore"
call :ensure_ignored .env
call :ensure_ignored .env.local
call :ensure_ignored node_modules
call :ensure_ignored .vercel
exit /b 0

:ensure_ignored
findstr /x /c:"%~1" ".gitignore" >nul 2>&1
if not errorlevel 1 exit /b 0
if not defined GI_ADDED >> ".gitignore" echo.
set "GI_ADDED=1"
>> ".gitignore" echo %~1
exit /b 0

:write_env
> "%ENVFILE%" echo # Local environment for "vercel dev". Created by setup.cmd - never commit this file.
>> "%ENVFILE%" echo # Keys left blank during setup were skipped on purpose - each feature turns on only when its keys are set.
echo.
echo   Type or paste each value and press Enter. Press Enter alone to skip a key.
echo   Already set in Vercel? Skip them all - the live site keeps the keys it already has.
echo.
echo -- AI generation: CV, cover letters, assistants --
call :ask ANTHROPIC_API_KEY "Anthropic API key (starts with sk-ant-)"
echo.
echo -- Firebase Admin: sign-in checks, staff tools, live job search --
call :ask_firebase
echo.
echo -- Stripe billing - optional --
call :ask STRIPE_SECRET_KEY "Stripe secret key"
call :ask STRIPE_WEBHOOK_SECRET "Stripe webhook signing secret"
call :ask STRIPE_PRICE_ESSENTIAL_MONTHLY "Stripe Price ID, Essential monthly plan (price_...)"
call :ask STRIPE_PRICE_ESSENTIAL_ANNUAL "Stripe Price ID, Essential annual plan (price_...)"
call :ask STRIPE_PRICE_PRO_MONTHLY "Stripe Price ID, Pro monthly plan (price_...)"
call :ask STRIPE_PRICE_PRO_ANNUAL "Stripe Price ID, Pro annual plan (price_...)"
call :ask STRIPE_PRICE_PREMIUM_MONTHLY "Stripe Price ID, Premium monthly plan (price_...)"
call :ask STRIPE_PRICE_PREMIUM_ANNUAL "Stripe Price ID, Premium annual plan (price_...)"
echo.
echo -- Live job search - optional. The remote job boards need no key. --
call :ask ADZUNA_APP_ID "Adzuna app id"
call :ask ADZUNA_APP_KEY "Adzuna app key"
call :ask JOOBLE_API_KEY "Jooble API key"
echo   JSearch: RapidAPI (rapidapi.com) is the safest source for the key.
call :ask JSEARCH_API_KEY "JSearch API key (RapidAPI X-RapidAPI-Key)"
call :ask JSEARCH_PROVIDER "Type rapidapi if the key is from RapidAPI (leave empty for OpenWeb Ninja)"
call :ask JSEARCH_API_URL "JSearch search URL - only if the default does not work"
call :ask JSEARCH_AUTH_HEADER "JSearch auth header name - only for OpenWeb Ninja if x-api-key does not work"
echo.
echo   Saved to .env.local
exit /b 0

:ask
setlocal EnableDelayedExpansion
set "VAL="
set /p "VAL=  %~2: "
if defined VAL >> "%ENVFILE%" echo(%~1=!VAL!
endlocal
exit /b 0

:ask_firebase
setlocal
echo   Enter the path to your Firebase service-account .json file. You can drag the file
echo   into this window. Get it from Firebase console, Project settings, Service accounts,
echo   Generate new private key. It is converted to the base64 value the server expects.
set "SA_PATH="
set /p "SA_PATH=  Path to .json file, or Enter to skip: "
if not defined SA_PATH goto :fb_done
set "SA_PATH=%SA_PATH:"=%"
if not exist "%SA_PATH%" goto :fb_missing
set "FB_B64="
for /f "usebackq delims=" %%A in (`powershell -NoProfile -Command "[Convert]::ToBase64String([IO.File]::ReadAllBytes($env:SA_PATH))"`) do set "FB_B64=%%A"
if not defined FB_B64 goto :fb_failed
>> "%ENVFILE%" echo FIREBASE_SERVICE_ACCOUNT_BASE64=%FB_B64%
echo   Firebase key saved.
goto :fb_done
:fb_missing
echo   File not found - skipped.
goto :fb_done
:fb_failed
echo   Could not read that file - skipped.
:fb_done
endlocal
exit /b 0

:load_env
for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%ENVFILE%") do set "%%A=%%B"
exit /b 0

rem ---------------------------------------------------------------------------
rem  GitHub: init if needed, commit, add the remote, push.
rem ---------------------------------------------------------------------------
:github_setup
where git >nul 2>&1
if errorlevel 1 goto :gh_nogit
if exist ".git" goto :gh_haverepo
echo   Creating a new git repository here...
git init -q
if errorlevel 1 goto :gh_fail
git symbolic-ref HEAD refs/heads/main
:gh_haverepo
rem Keep files exactly as they are (LF) so Git stops printing line-ending warnings.
git config core.autocrlf false

set "GIT_NAME="
for /f "delims=" %%A in ('git config user.name 2^>nul') do set "GIT_NAME=%%A"
if defined GIT_NAME goto :gh_have_name
set /p "GIT_NAME=  Your name for commits: "
if not defined GIT_NAME goto :gh_no_ident
set "GIT_NAME=%GIT_NAME:"=%"
git config user.name "%GIT_NAME%"
:gh_have_name

set "GIT_MAIL="
for /f "delims=" %%A in ('git config user.email 2^>nul') do set "GIT_MAIL=%%A"
if defined GIT_MAIL goto :gh_have_mail
set /p "GIT_MAIL=  Your email for commits: "
if not defined GIT_MAIL goto :gh_no_ident
set "GIT_MAIL=%GIT_MAIL:"=%"
git config user.email "%GIT_MAIL%"
:gh_have_mail

git add -A
rem Safety net: never let the secret files be tracked, even if they were added earlier.
for %%F in (.env .env.local) do git ls-files --error-unmatch %%F >nul 2>&1 && git rm --cached -q %%F >nul 2>&1
git diff --cached --quiet
if not errorlevel 1 goto :gh_nothing
git commit -q -m "Update from setup.cmd"
if errorlevel 1 goto :gh_fail
echo   Committed your changes.
goto :gh_remote
:gh_nothing
echo   Nothing new to commit.

:gh_remote
set "GH_URL="
for /f "delims=" %%A in ('git remote get-url origin 2^>nul') do set "GH_URL=%%A"
if defined GH_URL goto :gh_push
echo.
echo   First create an EMPTY repository on GitHub: https://github.com/new
echo   Leave the README, .gitignore and license options unchecked. Then paste its URL,
echo   for example https://github.com/your-name/parcourai.git
set /p "GH_URL=  GitHub repository URL, or Enter to skip: "
if not defined GH_URL goto :gh_done
set "GH_URL=%GH_URL:"=%"
git remote add origin "%GH_URL%"
if errorlevel 1 goto :gh_fail

:gh_push
git rev-parse --verify HEAD >nul 2>&1
if errorlevel 1 goto :gh_nocommit
echo   Pushing to GitHub. A browser window may open so you can sign in.
git push -u origin HEAD
if errorlevel 1 goto :gh_pushfail
echo   Pushed to GitHub.
goto :gh_done

:gh_nogit
echo   Git was not found. Install Git for Windows from https://git-scm.com/download/win and run: setup.cmd github
exit /b 1
:gh_no_ident
echo   Git needs a name and an email to commit - skipped. Run: setup.cmd github
exit /b 1
:gh_nocommit
echo   There is nothing committed yet, so nothing to push.
exit /b 1
:gh_pushfail
echo.
echo   GitHub refused the push because that repository already has commits, for example a README.
echo     F = Replace what is on GitHub with this version. Recommended when that repository holds an older copy of this app.
echo     P = Merge what is on GitHub with this version. If a file conflicts, this version wins.
echo     S = Skip for now.
choice /c PFS /n /m "Choose F, P or S: "
if errorlevel 3 exit /b 1
if errorlevel 2 goto :gh_force
set "GH_BRANCH="
for /f "delims=" %%A in ('git branch --show-current 2^>nul') do set "GH_BRANCH=%%A"
if not defined GH_BRANCH set "GH_BRANCH=main"
git pull origin %GH_BRANCH% --allow-unrelated-histories --no-rebase -X ours --no-edit
if errorlevel 1 goto :gh_mergefail
git push -u origin HEAD
if errorlevel 1 goto :gh_fail
echo   Merged and pushed to GitHub.
exit /b 0
:gh_force
git push -u origin HEAD --force
if errorlevel 1 goto :gh_fail
echo   Pushed to GitHub, replacing what was there.
exit /b 0
:gh_mergefail
echo   The merge did not finish. Run git merge --abort, then run setup.cmd github and choose F, or ask for help.
exit /b 1
:gh_fail
echo   A git command failed - see the messages above.
exit /b 1
:gh_done
exit /b 0

rem ---------------------------------------------------------------------------
rem  Vercel: log in, link the project, optionally connect GitHub, upload the
rem  keys from .env.local to Production, optionally deploy.
rem ---------------------------------------------------------------------------
:vercel_setup
call :check_node
if errorlevel 1 exit /b 1

echo   Checking your Vercel login...
call npx --yes vercel whoami
if not errorlevel 1 goto :vc_loggedin
echo   Not logged in. A browser window opens so you can sign in to Vercel.
call npx --yes vercel login
if errorlevel 1 goto :vc_fail
:vc_loggedin

if exist ".vercel\project.json" goto :vc_linked
echo.
echo   Linking this folder to a Vercel project. Choose your existing project, or create one.
call npx --yes vercel link
if errorlevel 1 goto :vc_fail
:vc_linked

if not exist ".git" goto :vc_skip_git
git remote get-url origin >nul 2>&1
if errorlevel 1 goto :vc_skip_git
echo.
choice /c YN /n /m "Connect the GitHub repository to Vercel, so every push deploys by itself? [Y/N] "
if errorlevel 2 goto :vc_skip_git
call npx --yes vercel git connect --yes
if errorlevel 1 echo   Could not connect. Make sure the Vercel GitHub app is installed on your GitHub account.
:vc_skip_git

if not exist "%ENVFILE%" goto :vc_deploy
echo.
choice /c YN /n /m "Upload the keys saved in .env.local to Vercel, Production? Existing ones are overwritten. [Y/N] "
if errorlevel 2 goto :vc_deploy
for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%ENVFILE%") do (
  set "VC_KEY=%%A"
  set "VC_VAL=%%B"
  call :vc_putenv
)

:vc_deploy
echo.
echo   Changes to environment variables only apply to new deployments.
choice /c YN /n /m "Deploy to production now? [Y/N] "
if errorlevel 2 goto :vc_done
call npx --yes vercel deploy --prod
if errorlevel 1 goto :vc_fail
echo.
echo   Deployed. Open your site and press Ctrl+F5. The sidebar should show a Dashboard item and
echo   a line starting with Build at the bottom. If you do not see them, the old version is still being served.
:vc_done
exit /b 0
:vc_fail
echo   A Vercel step failed - see the messages above, then run: setup.cmd vercel
exit /b 1

:vc_putenv
powershell -NoProfile -Command "$env:VC_VAL | & npx.cmd --yes vercel env add $env:VC_KEY production --force; exit $LASTEXITCODE" >nul 2>&1
if errorlevel 1 goto :vc_put_failed
echo   Uploaded %VC_KEY%
exit /b 0
:vc_put_failed
echo   FAILED to upload %VC_KEY% - add it by hand in the Vercel dashboard.
exit /b 0
