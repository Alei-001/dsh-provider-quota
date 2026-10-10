<#
.SYNOPSIS
    提交、推送，并把插件更新进 DSH profile —— 升级这个插件的一条命令。

.DESCRIPTION
    升级一共三步：提交改动、推送到 GitHub、让 profile 重新解析远端（客户端改动
    刷新页面生效，宿主改动要重启 DSH）。这个脚本把三步串起来，并在最后报告依赖
    规格和当前提交。

.EXAMPLE
    .\scripts\upgrade.ps1 "fix: 余额阈值写入失败时保留草稿"

.EXAMPLE
    .\scripts\upgrade.ps1 -Test
    没有改动时也能跑（只重装），并且重装后跑一遍 258 条断言的冒烟测试。

.EXAMPLE
    .\scripts\upgrade.ps1 -DshCli "D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
    dsh 不在 PATH 上、也不在默认安装位置时指定 CLI 路径。
#>
[CmdletBinding()]
param(
    # 提交信息；省略时用时间戳。
    [Parameter(Position = 0)][string]$Message,

    # 发布版本号；给了就写进 package.json 再提交。
    # 它是"有没有新版本"的开关：页面里的更新提示比对的就是这个号，不 bump 就不提示。
    [string]$Version,

    # DSH profile 名。
    [string]$Profile = 'desktop',

    # 重装后跑一遍 scripts/smoke.mjs（需要 DSPQ_HARNESS_DIR 指向一份 React 安装）。
    [switch]$Test,

    # dsh CLI 路径；默认先找 PATH，再找桌面版默认位置。
    [string]$DshCli
)

$ErrorActionPreference = 'Stop'
$package = 'dsh-provider-quota'
$repo = Split-Path -Parent $PSScriptRoot
$profileDir = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile"

function Resolve-DshCli {
    param([string]$Explicit)
    if ($Explicit) {
        if (-not (Test-Path $Explicit)) { throw "指定的 dsh CLI 不存在：$Explicit" }
        return $Explicit
    }
    $onPath = Get-Command dsh -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($onPath) { return $onPath.Source }
    $fallback = 'D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
    if (Test-Path $fallback) { return $fallback }
    throw '找不到 dsh 命令：把它加入 PATH，或用 -DshCli 指定路径。'
}

$dsh = Resolve-DshCli -Explicit $DshCli

Push-Location $repo
try {
    # 0. 版本号（可选）
    if ($Version) {
        $manifestPath = Join-Path $repo 'package.json'
        $manifest = Get-Content $manifestPath -Raw
        if ($manifest -match '"version"\s*:\s*"' + [regex]::Escape($Version) + '"') {
            Write-Host "[0/3] 版本已是 $Version。" -ForegroundColor DarkGray
        } else {
            $bumped = $manifest -replace '("version"\s*:\s*")[^"]+(")', "`${1}$Version`${2}"
            if ($bumped -eq $manifest) { throw 'package.json 里没有找到 version 字段。' }
            Set-Content $manifestPath -Value $bumped -NoNewline -Encoding UTF8
            Write-Host "[0/3] package.json 版本 → $Version" -ForegroundColor Green
        }
    }

    # 1. 提交
    git add -A
    if (git diff --cached --name-only) {
        if (-not $Message) { $Message = 'update: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm') }
        git commit -m $Message | Out-Null
        Write-Host "[1/3] 已提交：$Message" -ForegroundColor Green
    } else {
        Write-Host '[1/3] 没有需要提交的改动。' -ForegroundColor DarkGray
    }

    # 2. 推送
    $upstream = git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>$null
    $ahead = 0
    if ($LASTEXITCODE -eq 0 -and $upstream) { $ahead = [int](git rev-list --count "$upstream..HEAD") }
    if ($ahead -gt 0) {
        git push | Out-Null
        if ($LASTEXITCODE -ne 0) { throw '推送失败。' }
        Write-Host "[2/3] 已推送 $ahead 个提交到 $upstream。" -ForegroundColor Green
    } else {
        Write-Host '[2/3] 远端已是最新。' -ForegroundColor DarkGray
    }

    # 3. 更新安装
    $profileJson = Join-Path $profileDir 'package.json'
    if (-not (Test-Path $profileJson)) { throw "找不到 profile：$profileJson" }
    $spec = (Get-Content $profileJson -Raw | ConvertFrom-Json).dependencies.$package
    if (-not $spec) {
        throw "profile 的 dependencies 里没有 $package。先跑一次：`n  dsh plugin --profile $Profile add ""git+ssh://git@github.com/Alei-001/$package.git"""
    }
    & $dsh plugin --profile $Profile update $package
    if ($LASTEXITCODE -ne 0) { throw "更新失败（exit $LASTEXITCODE）。" }
    $head = (git rev-parse --short HEAD)
    Write-Host "[3/3] 已更新 $package（$spec @ $head）。" -ForegroundColor Green

    if ($Test) {
        $env:DSPQ_PLUGIN_DIR = Join-Path $profileDir "node_modules\$package"
        & node (Join-Path $PSScriptRoot 'smoke.mjs')
        if ($LASTEXITCODE -ne 0) { throw '冒烟测试未通过。' }
    }

    Write-Host ''
    Write-Host '客户端改动刷新页面即可；宿主改动要重启 DSH。' -ForegroundColor Cyan
} finally {
    Pop-Location
}
