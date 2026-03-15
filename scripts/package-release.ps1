$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptRoot

$manifestPath = Join-Path $projectRoot "manifest.json"
if (-not (Test-Path $manifestPath)) {
  throw "manifest.json not found: $manifestPath"
}

$manifest = Get-Content -Raw -Path $manifestPath | ConvertFrom-Json
$version = [string]$manifest.version
if ([string]::IsNullOrWhiteSpace($version)) {
  throw "manifest.json does not contain a valid version."
}

$packageName = "select-element-v$version"
$releaseRoot = Join-Path $projectRoot "release"
$packageRoot = Join-Path $releaseRoot $packageName
$zipPath = Join-Path $releaseRoot ($packageName + ".zip")

$packageItems = @(
  "manifest.json",
  "service-worker.js",
  "content-script.js",
  "content-style.css",
  "sidepanel.html",
  "sidepanel.css",
  "sidepanel.js",
  "utils.js",
  "icon",
  "README.md",
  "LICENSE"
)

if (-not (Test-Path $releaseRoot)) {
  New-Item -ItemType Directory -Path $releaseRoot | Out-Null
}

if (Test-Path $packageRoot) {
  Remove-Item -Recurse -Force $packageRoot
}

if (Test-Path $zipPath) {
  Remove-Item -Force $zipPath
}

New-Item -ItemType Directory -Path $packageRoot | Out-Null

foreach ($item in $packageItems) {
  $sourcePath = Join-Path $projectRoot $item
  if (-not (Test-Path $sourcePath)) {
    throw "Required package item not found: $item"
  }

  $destinationPath = Join-Path $packageRoot $item
  $parentPath = Split-Path -Parent $destinationPath
  if (-not [string]::IsNullOrWhiteSpace($parentPath) -and -not (Test-Path $parentPath)) {
    New-Item -ItemType Directory -Path $parentPath -Force | Out-Null
  }

  Copy-Item -Path $sourcePath -Destination $destinationPath -Recurse -Force
}

Compress-Archive -Path $packageRoot -DestinationPath $zipPath -Force

Write-Host "Created package directory: $packageRoot"
Write-Host "Created release zip: $zipPath"
