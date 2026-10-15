<#
  Coopanion 铁盆玩具补丁:安装、卸载与兼容性检查(Windows x64)。

  这个脚本是补丁包的统一入口,包里的三个 cmd 就是包着它:
    Install.cmd    = -Mode install    安装(默认)
    Uninstall.cmd  = -Mode uninstall  卸载,把官方文件还原回去
    Check.cmd      = -Mode check      只做兼容性检查,不改任何文件
  也可以直接:powershell -NoProfile -ExecutionPolicy Bypass -File setup.ps1 -Mode check -AppPath "D:\Coopanion"

  可用参数:-AppPath 指定安装目录(可以给 Coopanion.exe 的路径);-Force 在核对不通过时继续
  (安装=跳过冲突照写,卸载=跳过已被改动的文件);-NoPause 结束后不停留。

  它只写 resources\app\node_modules\cortico-world-desktop-pet\ 下的文件。写之前逐文件核对
  manifest.json 里记下的基准版本 sha256,对不上就列出来并停下(exit 2,-Force 可跳过)。被替换
  的文件备份在 <安装目录>\data\toy-patch\backup\<补丁号>\,安装记录是 data\toy-patch\installed.json,
  安装包副本和 Windows「应用」里的卸载入口也写在那里;卸载后备份与记录保留,便于追溯。

  注意:这个文件在补丁 zip 里带 UTF-8 BOM,Windows PowerShell 5.1 才能正确读到中文;仓库里的
  这份没有 BOM(本地调试用),安装时会把自己按 BOM 复制进 data\toy-patch\releases\ 供卸载使用。
#>
[CmdletBinding()]
param(
  [ValidateSet('install', 'uninstall', 'check', 'detect')][string]$Mode = 'install',
  [string]$AppPath = '',
  [switch]$Force,
  [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
# PowerShell 7(特别是应用商店版)会把自带的模块目录写进 PSModulePath;Windows PowerShell 5.1
# 随后自动加载模块时会挑到只兼容 Core 的同名清单(典型症状:Get-FileHash 这类命令凭空消失)。
# 先把这些不在 5.1 体系里的目录剔掉——只影响本脚本进程。
if ($PSVersionTable.PSVersion.Major -lt 6 -and $env:PSModulePath) {
  $kept = @()
  foreach ($part in $env:PSModulePath.Split(';')) {
    if ($part -and $part -notmatch '\\WindowsApps\\' -and $part -notmatch '\\PowerShell\\7[^\\]*\\Modules') { $kept += $part }
  }
  $env:PSModulePath = ($kept -join ';')
}
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding } catch { }
$bundle = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$selfPath = if ($PSCommandPath) { $PSCommandPath } else { $MyInvocation.MyCommand.Path }
$recordRel = 'data\toy-patch\installed.json'
$script:exitCode = 1

function Say([string]$text, [string]$color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Die([string]$text, [int]$code = 1) { $script:exitCode = $code; throw $text }
# 直接走 .NET:不依赖 Get-FileHash(见上面 PSModulePath 的说明),5.1 和 7 都稳。
function Get-Sha256([string]$path) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $stream = [IO.File]::OpenRead($path)
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose() }
  } finally { $sha.Dispose() }
}
function Read-Json([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  return (Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json)
}

# ---------------------------------------------------------------- 找安装目录

function Test-App([string]$p) {
  if (-not $p) { return $false }
  return (Test-Path -LiteralPath (Join-Path $p 'resources\app\package.json'))
}

function Add-Candidate($list, [string]$p) {
  if (-not $p -or -not (Test-App $p)) { return }
  $full = [IO.Path]::GetFullPath($p).TrimEnd('\')
  if (-not $list.Contains($full)) { $list.Add($full) }
}

# The per-user installer writes InstallLocation under the uninstall key; the default location it
# moves to is %USERPROFILE%\Coopanion (installer/nsis.nsh customInit). 探测顺序:正在运行的进程
# → 注册表卸载项 → 常见目录 → 开始菜单/桌面快捷方式。
function Find-Apps {
  $found = New-Object 'System.Collections.Generic.List[string]'
  Get-CimInstance Win32_Process -Filter "Name='Coopanion.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.ExecutablePath) { Add-Candidate $found (Split-Path -Parent $_.ExecutablePath) }
  }
  foreach ($root in @(
      'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
      'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
      'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
    Get-ItemProperty $root -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -match '^Coopanion' -and $_.InstallLocation } |
      ForEach-Object { Add-Candidate $found $_.InstallLocation }
  }
  foreach ($base in @(
      $env:USERPROFILE, (Join-Path $env:USERPROFILE 'Coopanion'),
      $env:LOCALAPPDATA, (Join-Path $env:LOCALAPPDATA 'Programs\Coopanion'),
      $env:ProgramFiles, ${env:ProgramFiles(x86)},
      $bundle, (Split-Path -Parent $bundle))) {
    if (-not $base) { continue }
    Add-Candidate $found $base
    Add-Candidate $found (Join-Path $base 'Coopanion')
  }
  $shell = New-Object -ComObject WScript.Shell
  foreach ($folder in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('StartMenu'), [Environment]::GetFolderPath('CommonStartMenu'))) {
    if (-not $folder -or -not (Test-Path -LiteralPath $folder)) { continue }
    Get-ChildItem -LiteralPath $folder -Filter '*Coopanion*.lnk' -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
      $link = $shell.CreateShortcut($_.FullName)
      if ($link.TargetPath) { Add-Candidate $found (Split-Path -Parent $link.TargetPath) }
    }
  }
  return $found
}

function Select-App {
  $apps = @(Find-Apps)
  if ($apps.Count -eq 1) { return $apps[0] }
  if ($apps.Count -gt 1) {
    for ($n = 0; $n -lt $apps.Count; $n++) { Say "[$($n + 1)] $($apps[$n])" }
    $selection = Read-Host '请选择软件副本的编号'
    $index = 0
    if (-not [int]::TryParse($selection, [ref]$index) -or $index -lt 1 -or $index -gt $apps.Count) {
      Die '选择无效,未修改文件。'
    }
    return $apps[$index - 1]
  }
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object System.Windows.Forms.OpenFileDialog
    $dialog.Title = '选择 Coopanion.exe'
    $dialog.Filter = 'Coopanion|Coopanion.exe'
    if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { Say '已取消。'; exit 0 }
    return (Split-Path -Parent $dialog.FileName)
  } catch {
    Die '没有找到 Coopanion:用 -AppPath 指定安装目录,例如 Install.cmd -AppPath "D:\Coopanion"。'
  }
}

# ---------------------------------------------------------------- 通用小工具

function Assert-ManifestPath([string]$path) {
  if ($path -notmatch '^node_modules/cortico-world-desktop-pet/.+' -or $path -match '\.\.') {
    Die "补丁清单里的路径不合法:$path"
  }
}

function Test-Writable([string]$app) {
  $dir = Join-Path $app 'data\toy-patch'
  try {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $probe = Join-Path $dir ('.probe-' + [guid]::NewGuid().ToString('n'))
    Set-Content -LiteralPath $probe -Value 'ok' -Encoding ASCII
    Remove-Item -LiteralPath $probe -Force
    return $true
  } catch {
    return $false
  }
}

function Assert-AppClosed {
  $running = @(Get-Process -Name 'Coopanion' -ErrorAction SilentlyContinue)
  if ($running.Count) { Die 'Coopanion 正在运行:先从托盘菜单退出它,再重新运行安装或卸载。' }
}

# 清单包完整性:release-id.txt 是 manifest.json 的 sha256 前 16 位;manifest 里记着每个载荷文件
# 的 sha256。任何一处对不上都拒绝继续,相当于 Window-Perch 的 files.sha256.json 检查。
function Assert-Bundle([bool]$requirePayload) {
  $manifestPath = Join-Path $bundle 'manifest.json'
  $releasePath = Join-Path $bundle 'release-id.txt'
  if (-not (Test-Path -LiteralPath $manifestPath) -or -not (Test-Path -LiteralPath $releasePath)) {
    Die '安装包不完整:缺 manifest.json 或 release-id.txt。请重新解压补丁包。'
  }
  $release = (Get-Content -LiteralPath $releasePath -Raw -Encoding UTF8).Trim().ToLowerInvariant()
  if ((Get-Sha256 $manifestPath).Substring(0, 16) -ne $release) { Die '安装包清单损坏,请重新解压补丁包。' }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $payloadDir = Join-Path $bundle 'payload'
  if (-not (Test-Path -LiteralPath $payloadDir)) {
    if ($requirePayload) { Die '安装包不完整:缺 payload\ 目录。请重新解压补丁包。' }
    Say '这份副本不带文件载荷(来自安装记录),只核对清单。' Yellow
    return $manifest
  }
  foreach ($f in @($manifest.files)) {
    Assert-ManifestPath $f.path
    if ($f.removed) { continue }
    $src = Join-Path $payloadDir ($f.path -replace '/', '\')
    if (-not (Test-Path -LiteralPath $src) -or (Get-Sha256 $src) -ne $f.sha256) {
      Die "安装包文件损坏或被修改:$($f.path)。请重新解压补丁包。"
    }
  }
  return $manifest
}

# 逐文件核对目标当前状态是否符合补丁的基准版本;返回冲突列表。
function Get-Conflicts([string]$app, $manifest) {
  $appRoot = Join-Path $app 'resources\app'
  $conflicts = New-Object 'System.Collections.Generic.List[string]'
  foreach ($f in @($manifest.files)) {
    $target = Join-Path $appRoot ($f.path -replace '/', '\')
    $exists = Test-Path -LiteralPath $target
    if ($f.removed) {
      if ($exists -and $f.baseSha256 -and (Get-Sha256 $target) -ne $f.baseSha256) { $conflicts.Add("$($f.path)(内容和基准版本不一致)") }
      continue
    }
    if (-not $exists) {
      if ($f.baseSha256) { $conflicts.Add("$($f.path)(基准版本有这个文件,这里没有)") }
      continue
    }
    if (-not $f.baseSha256) { $conflicts.Add("$($f.path)(补丁要新增,这里已有同名文件)"); continue }
    if ((Get-Sha256 $target) -ne $f.baseSha256) { $conflicts.Add("$($f.path)(内容和基准版本不一致)") }
  }
  return $conflicts
}

# 补丁文件是否还是安装时写下的样子;返回被改动的文件列表(空=完好)。
function Test-RecordState([string]$app, $record) {
  $appRoot = Join-Path $app 'resources\app'
  $changed = New-Object 'System.Collections.Generic.List[string]'
  foreach ($f in @($record.files)) {
    $target = Join-Path $appRoot ($f.path -replace '/', '\')
    if ($f.removed) {
      if (Test-Path -LiteralPath $target) { $changed.Add($f.path) }
    } elseif ((-not (Test-Path -LiteralPath $target)) -or ((Get-Sha256 $target) -ne $f.sha256)) {
      $changed.Add($f.path)
    }
  }
  return $changed
}

function Write-Record([string]$app, $record) {
  $recordPath = Join-Path $app $recordRel
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $recordPath) | Out-Null
  Set-Content -LiteralPath $recordPath -Value ($record | ConvertTo-Json -Depth 8) -Encoding UTF8
}

# 把安装记录里的文件还原:备份的拷回去,补丁新增的删掉。forceSkipChanged 时跳过已被改动的文件
# (不覆盖别人新写的内容)。返回 $null 前会先核对;核对不过且不允许跳过时以 exit 2 停下。
function Restore-Patch([string]$app, $record, [bool]$forceSkipChanged) {
  $appRoot = Join-Path $app 'resources\app'
  $backupDir = Join-Path $app ('data\toy-patch\backup\' + $record.patchId)
  $changed = Test-RecordState $app $record
  if ($changed.Count -and -not $forceSkipChanged) {
    Say '这些文件已被其他更新或手动改过,不覆盖它们:' Red
    foreach ($c in $changed) { Say "  $c" Red }
    Say '确认不再需要补丁文件时,加 -Force 跳过这些文件再卸载。' Yellow
    Die '卸载中止,未改动任何文件。' 2
  }
  $restored = 0
  $removed = 0
  $skipped = New-Object 'System.Collections.Generic.List[string]'
  $missing = New-Object 'System.Collections.Generic.List[string]'
  foreach ($f in @($record.files)) {
    $target = Join-Path $appRoot ($f.path -replace '/', '\')
    $backup = Join-Path $backupDir ($f.path -replace '/', '\')
    if ($forceSkipChanged -and $changed.Contains($f.path)) { $skipped.Add($f.path); continue }
    if ($f.backup) {
      if (-not (Test-Path -LiteralPath $backup)) { $missing.Add($f.path); continue }
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
      Copy-Item -LiteralPath $backup -Destination $target -Force
      $restored++
    } elseif (Test-Path -LiteralPath $target) {
      Remove-Item -LiteralPath $target -Force
      $removed++
    }
  }
  return @{ restored = $restored; removed = $removed; skipped = $skipped; missing = $missing }
}

# ---------------------------------------------------------------- 「应用」卸载入口

function Get-PatchKey([string]$app) {
  $id = ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($app.ToLowerInvariant())))).Replace('-', '').Substring(0, 16)
  return 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\CoopanionToyPatch-' + $id
}

# 把 setup.ps1 和清单复制进 data\toy-patch\releases\<补丁号>\,卸载入口指向这份副本,以后
# 删掉补丁 zip 也能从「设置 → 应用」卸载。复制时显式写 BOM,PowerShell 5.1 才读得到中文。
function Publish-Releases([string]$app, $manifest) {
  $dir = Join-Path $app ('data\toy-patch\releases\' + $manifest.patchId)
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  if ($selfPath -and (Test-Path -LiteralPath $selfPath)) {
    $text = Get-Content -LiteralPath $selfPath -Raw -Encoding UTF8
    [IO.File]::WriteAllText((Join-Path $dir 'setup.ps1'), $text, (New-Object System.Text.UTF8Encoding($true)))
  }
  foreach ($name in @('manifest.json', 'release-id.txt')) {
    $src = Join-Path $bundle $name
    if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination $dir -Force }
  }
  return $dir
}

function Register-UninstallEntry([string]$app, $manifest, [string]$releaseDir) {
  $key = Get-PatchKey $app
  $uninstall = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $releaseDir 'setup.ps1') + '" -Mode uninstall -AppPath "' + $app + '"'
  New-Item -Path $key -Force | Out-Null
  foreach ($entry in @{
      DisplayName = 'Coopanion 铁盆玩具补丁'
      DisplayVersion = ([string]$manifest.app.version + '-v' + [string]$manifest.patchVersion)
      Publisher = 'Coopanion 社区补丁'
      InstallLocation = $app
      UninstallString = $uninstall
      DisplayIcon = (Join-Path $app 'Coopanion.exe')
    }.GetEnumerator()) {
    New-ItemProperty -Path $key -Name $entry.Key -Value $entry.Value -PropertyType String -Force | Out-Null
  }
}

function Remove-UninstallEntry([string]$app) {
  $key = Get-PatchKey $app
  if (Test-Path $key) { Remove-Item -LiteralPath $key -Force }
}

# ---------------------------------------------------------------- 三种操作

function Invoke-Check([string]$app) {
  $manifest = Assert-Bundle $false
  $appRoot = Join-Path $app 'resources\app'
  $pkg = Read-Json (Join-Path $appRoot 'package.json')
  if ($pkg -and $pkg.name -and $pkg.name -ne 'coopanion') { Die "「$app」的 resources\app 不是 Coopanion 的应用包(name=$($pkg.name))。" }
  $appVersion = if ($pkg -and $pkg.version) { [string]$pkg.version } else { '未知' }
  Say "安装目录:$app"
  Say "Coopanion $appVersion;补丁 $($manifest.patchId),基准 v$($manifest.app.version)"
  $failed = New-Object 'System.Collections.Generic.List[string]'
  if ($appVersion -ne '未知' -and $appVersion -ne [string]$manifest.app.version) {
    Say '应用版本和补丁基准不一样,下面按文件逐一核对。' Yellow
  }
  if (-not (Test-Writable $app)) {
    $failed.Add('安装目录不可写')
    Say '安装目录不可写:安装/卸载需要写权限,装在受保护目录时请右键以管理员身份运行。' Red
  }
  if (@(Get-Process -Name 'Coopanion' -ErrorAction SilentlyContinue).Count) {
    Say '提示:Coopanion 正在运行;安装和卸载前需要先从托盘退出它(检查不受影响)。' Yellow
  }
  $record = Read-Json (Join-Path $app $recordRel)
  if ($record -and $record.state -eq 'installed') {
    $changed = Test-RecordState $app $record
    if ($changed.Count -eq 0) {
      Say "已安装补丁 $($record.patchId),文件与安装记录一致。" Green
      if ($record.patchId -eq $manifest.patchId) { Say '不需要重复安装;要还原官方文件就运行 Uninstall.cmd。' }
      else { Say "再运行安装会先自动还原它,然后装入本包 $($manifest.patchId)。" }
      if ($failed.Count) { Die '兼容性检查未通过。' 2 }
      Say '兼容性检查通过。' Green
      return
    }
    Say "已装补丁 $($record.patchId),但有 $($changed.Count) 个文件已被改动:" Yellow
    foreach ($c in $changed) { Say "  $c" Yellow }
    Die '兼容性检查未通过,未改动任何文件。' 2
  }
  $conflicts = Get-Conflicts $app $manifest
  if ($conflicts.Count) {
    Say '这些文件和补丁的基准版本对不上:' Red
    foreach ($c in $conflicts) { Say "  $c" Red }
    $failed.Add('文件哈希与基准版本不一致')
  }
  if ($failed.Count) { Die '兼容性检查未通过,未改动任何文件。' 2 }
  Say '兼容性检查通过,可以安装(Install.cmd)。' Green
}

function Invoke-Install([string]$app) {
  $manifest = Assert-Bundle $true
  $appRoot = Join-Path $app 'resources\app'
  $pkg = Read-Json (Join-Path $appRoot 'package.json')
  if ($pkg -and $pkg.name -and $pkg.name -ne 'coopanion') { Die "「$app」的 resources\app 不是 Coopanion 的应用包(name=$($pkg.name))。" }
  $appVersion = if ($pkg -and $pkg.version) { [string]$pkg.version } else { '未知' }
  Say "安装目录:$app"
  Say "Coopanion $appVersion;补丁 $($manifest.patchId),基准 v$($manifest.app.version)"
  if ($appVersion -ne '未知' -and $appVersion -ne [string]$manifest.app.version) {
    Say '应用版本和补丁基准不一样,下面按文件逐一核对。' Yellow
  }

  $recordPath = Join-Path $app $recordRel
  $record = Read-Json $recordPath
  if ($record -and $record.state -eq 'installed') {
    $changed = Test-RecordState $app $record
    if ($changed.Count -eq 0) {
      Say "检测到已装过补丁 $($record.patchId),先还原它,再按本包安装…" Yellow
      Restore-Patch $app $record $false | Out-Null
    } else {
      $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
      $historyDir = Join-Path $app 'data\toy-patch\history'
      New-Item -ItemType Directory -Force -Path $historyDir | Out-Null
      Copy-Item -LiteralPath $recordPath -Destination (Join-Path $historyDir ("installed-$($record.patchId)-$stamp.json")) -Force
      Say '上次的补丁记录和当前文件对不上(可能已更新过软件):把记录存进历史,继续按本包核对。' Yellow
    }
  }

  $conflicts = Get-Conflicts $app $manifest
  if ($conflicts.Count) {
    Say '这些文件和补丁的基准版本对不上:' Red
    foreach ($c in $conflicts) { Say "  $c" Red }
    Say '多半是应用已更新到别的版本。等对应版本的补丁,或确认没问题再加 -Force。' Yellow
    if (-not $Force) { Die '兼容性核对未通过,未改动任何文件。' 2 }
    Say '-Force:按现在这样继续。' Yellow
  }

  if (-not (Test-Writable $app)) { Die "安装目录不可写($app)。装在受保护目录时,请右键以管理员身份运行 Install.cmd。" }
  Assert-AppClosed

  $backupDir = Join-Path $app ('data\toy-patch\backup\' + $manifest.patchId)
  New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
  $applied = New-Object System.Collections.ArrayList
  try {
    foreach ($f in @($manifest.files)) {
      $target = Join-Path $appRoot ($f.path -replace '/', '\')
      $backup = Join-Path $backupDir ($f.path -replace '/', '\')
      if ($f.removed) {
        if (Test-Path -LiteralPath $target) {
          New-Item -ItemType Directory -Force -Path (Split-Path -Parent $backup) | Out-Null
          Copy-Item -LiteralPath $target -Destination $backup -Force
          Remove-Item -LiteralPath $target -Force
          [void]$applied.Add(@{ path = $f.path; removed = $true; sha256 = $null; backup = $true })
        }
        continue
      }
      $hadBackup = $false
      if (Test-Path -LiteralPath $target) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $backup) | Out-Null
        Copy-Item -LiteralPath $target -Destination $backup -Force
        $hadBackup = $true
      }
      $source = Join-Path $bundle ('payload\' + ($f.path -replace '/', '\'))
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
      Copy-Item -LiteralPath $source -Destination $target -Force
      [void]$applied.Add(@{ path = $f.path; removed = $false; sha256 = $f.sha256; backup = $hadBackup })
    }
  } catch {
    Say '写入中途出错,正在撤回这次写过的文件…' Yellow
    foreach ($a in $applied) {
      $target = Join-Path $appRoot ($a.path -replace '/', '\')
      $backup = Join-Path $backupDir ($a.path -replace '/', '\')
      if ($a.backup) { Copy-Item -LiteralPath $backup -Destination $target -Force }
      else { Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue }
    }
    throw
  }

  Write-Record $app @{
    state = 'installed'; patchId = $manifest.patchId; patchVersion = $manifest.patchVersion
    baseVersion = $manifest.app.version; appVersion = $appVersion
    installedAt = (Get-Date).ToString('o'); files = @($applied)
  }

  $releaseDir = Publish-Releases $app $manifest
  Register-UninstallEntry $app $manifest $releaseDir

  Say "补丁装好了:$($applied.Count) 个文件写进 $appRoot" Green
  Say '已添加卸载入口:Windows 设置 → 应用 →「Coopanion 铁盆玩具补丁」。'
  Say '打开 Coopanion 生效:装扮页最后一行给玩具挑图、起名;高级模式里桌宠 World 的配置页有开关和响声。'
  Say '官方更新会换掉 resources\ 目录,补丁随之失效;更新后跑一次对应新版本的补丁。' Yellow
}

function Invoke-Uninstall([string]$app) {
  $record = Read-Json (Join-Path $app $recordRel)
  Remove-UninstallEntry $app
  if (-not $record) { Say '这份安装里没有补丁记录,不需要卸载。'; return }
  if ($record.state -ne 'installed') { Say "补丁 $($record.patchId) 已经还原过了,没有要卸载的。"; return }
  Assert-AppClosed
  $result = Restore-Patch $app $record ([bool]$Force)
  $record.state = 'restored'
  Add-Member -InputObject $record -NotePropertyName restoredAt -NotePropertyValue (Get-Date).ToString('o') -Force
  Write-Record $app $record
  Say "已卸载补丁 $($record.patchId):还原 $($result.restored) 个官方文件,删除 $($result.removed) 个新增文件。" Green
  if ($result.skipped.Count) { Say ('-Force 跳过了这些已被改动的文件(保留现状):' + ($result.skipped -join '、')) Yellow }
  if ($result.missing.Count) { Say ('这些文件的备份不见了,没能还原:' + ($result.missing -join '、')) Yellow }
  Say '备份与安装记录保留在 data\toy-patch\ 便于追溯;要再装就重跑 Install.cmd。'
}

# ---------------------------------------------------------------- 入口

try {
  if ($Mode -eq 'detect') {
    $items = @()
    foreach ($candidate in @(Find-Apps)) {
      $pkg = Read-Json (Join-Path $candidate 'resources\app\package.json')
      $record = Read-Json (Join-Path $candidate $recordRel)
      $items += @{
        path = $candidate
        version = if ($pkg -and $pkg.version) { [string]$pkg.version } else { '' }
        patched = [bool]($record -and $record.state -eq 'installed')
      }
    }
    ConvertTo-Json -InputObject @($items) -Depth 4
    exit 0
  }

  if ($AppPath -and [IO.Path]::GetExtension($AppPath) -eq '.exe') { $AppPath = Split-Path -Parent $AppPath }
  if (-not $AppPath) { $AppPath = Select-App }
  $AppPath = [IO.Path]::GetFullPath($AppPath).TrimEnd('\')
  if (-not (Test-App $AppPath)) { Die "「$AppPath」里没有 resources\app\package.json:这不像 Coopanion 的安装目录。" }

  switch ($Mode) {
    'check' { Invoke-Check $AppPath }
    'install' { Invoke-Install $AppPath }
    'uninstall' { Invoke-Uninstall $AppPath }
  }
} catch {
  Say ([string]$_.Exception.Message) Red
  if (-not $NoPause) { Read-Host '按回车关闭' }
  exit $script:exitCode
}
if (-not $NoPause) { Read-Host '按回车关闭' }
