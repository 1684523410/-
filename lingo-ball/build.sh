#!/bin/bash
# Builds out/LingoBall-<ver>.zip. Usage: bash lingo-ball/build.sh  (from project root)
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
VER=$(grep -oP '(?<=<Version>)[^<]+' "$ROOT/lingo-ball/LingoBall.csproj")
export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
(cd "$ROOT/lingo-ball" && /workspace/.dotnet/dotnet build -c Release -v q | grep -E " error |Build succeeded" | sort -u)
B="$ROOT/lingo-ball/bin/Release/net48"
(cd "$ROOT/lingo-bridge" && npx esbuild src/ball-agent.ts --bundle --platform=node --target=node18 --format=cjs --minify --log-level=error --outfile="$B/lingo-agent.js")
rm -rf "$ROOT/out/LingoBall" && mkdir -p "$ROOT/out/LingoBall"
cp "$B/LingoBall.exe" "$B/LingoBall.exe.config" "$B/Microsoft.Web.WebView2.Core.dll" "$B/Microsoft.Web.WebView2.WinForms.dll" "$B/lingo-agent.js" "$ROOT/out/LingoBall/"
cp -r "$B/runtimes" "$ROOT/out/LingoBall/"
cp "$ROOT/lingo-ball/使用说明.txt" "$ROOT/out/LingoBall/"
cd "$ROOT/out" && rm -f LingoBall-*.zip && python3 -c "
import zipfile,os
z=zipfile.ZipFile('LingoBall-$VER.zip','w',zipfile.ZIP_DEFLATED)
for r,d,f in os.walk('LingoBall'):
  for x in f: z.write(os.path.join(r,x))
z.close()"
ls -la "$ROOT/out/LingoBall-$VER.zip"
