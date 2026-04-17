const vscode = require("vscode");
const { exec } = require("child_process");
const path = require("path");
const util = require("util");

const execAsync = util.promisify(exec);

let _isGitRepo = null;
let _refreshTimer = null;
let _state = {
  mode: "compareBase",
  baseBranch: null,
  localCompareTarget: "HEAD", // LOCAL 모드에서 비교할 대상
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function getCwd() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  return folders[0].uri.fsPath;
}

async function run(cmd, cwd) {
  try {
    const { stdout } = await execAsync(cmd, {
      cwd,
      maxBuffer: 1024 * 1024 * 10,
    });
    return { ok: true, out: stdout.trim() };
  } catch (e) {
    return { ok: false, out: "", err: String(e.message || e) };
  }
}

function extCategory(filePath) {
  const ext = path.extname(filePath).toLowerCase().replace(".", "");
  if (["astro", "html", "vue", "svelte"].includes(ext)) return "MARKUP";
  if (["jsx", "tsx"].includes(ext)) return "JSX";
  if (["js", "ts", "mjs", "cjs"].includes(ext)) return "JS";
  if (["css", "scss", "sass", "less"].includes(ext)) return "CSS";
  if (["png", "jpg", "jpeg", "gif", "webp", "ico", "avif", "svg"].includes(ext))
    return "IMG";
  return "ETC";
}

function guessLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if ([".js", ".mjs", ".cjs"].includes(ext)) return "javascript";
  if (ext === ".ts") return "typescript";
  if (ext === ".jsx") return "javascriptreact";
  if (ext === ".tsx") return "typescriptreact";
  if (ext === ".css") return "css";
  if (ext === ".scss") return "scss";
  if (ext === ".sass") return "sass";
  if (ext === ".less") return "less";
  if ([".html", ".astro"].includes(ext)) return "html";
  if (ext === ".json") return "json";
  if (ext === ".svg") return "xml";
  return "plaintext";
}

function isImageFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return [".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".avif"].includes(
    ext,
  );
}

function getNonce() {
  let text = "";
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++)
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}

function makeGitUri(absPath, ref) {
  const fileUri = vscode.Uri.file(absPath);
  return vscode.Uri.parse(
    `git:${fileUri.path}?${encodeURIComponent(JSON.stringify({ path: absPath, ref }))}`,
  );
}

// ── Git ───────────────────────────────────────────────────────────────────────

async function getDefaultBranch(cwd) {
  const res = await run("git symbolic-ref refs/remotes/origin/HEAD", cwd);
  if (res.ok) {
    const match = res.out.match(/refs\/remotes\/origin\/(.+)/);
    if (match) return match[1];
  }
  if ((await run("git rev-parse --verify origin/master", cwd)).ok)
    return "master";
  if ((await run("git rev-parse --verify origin/main", cwd)).ok) return "main";
  const local = await run("git branch --list master", cwd);
  if (local.ok && local.out.trim()) return "master";
  return "main";
}

async function getCurrentBranch(cwd) {
  const r = await run("git rev-parse --abbrev-ref HEAD", cwd);
  return r.ok ? r.out : "(unknown)";
}

async function getFileStatusVsBranch(cwd, filePath, targetBranch) {
  // 1. 파일이 target 브랜치에 있는지 확인
  const checkFile = await run(
    `git cat-file -e ${targetBranch}:"${filePath}" 2>/dev/null`,
    cwd,
  );
  const existsInTarget = checkFile.ok;

  // 2. 작업 디렉토리에 파일이 있는지 확인
  const fs = require("fs");
  const absPath = path.join(cwd, filePath);
  const existsInWorking = fs.existsSync(absPath);

  let status;
  if (!existsInTarget && existsInWorking) {
    // target에는 없고 로컬에만 있음 = 추가
    status = "A";
  } else if (existsInTarget && !existsInWorking) {
    // target에는 있고 로컬에서 삭제됨 = 삭제
    status = "D";
  } else if (existsInTarget && existsInWorking) {
    // 둘 다 있음 = 수정 여부 확인
    const diffCheck = await run(
      `git diff ${targetBranch} -- "${filePath}"`,
      cwd,
    );
    if (diffCheck.ok && diffCheck.out.trim()) {
      status = "M";
    } else {
      // 변경사항 없음 - 리스트에 추가 안 함
      return null;
    }
  } else {
    return null;
  }

  return {
    status,
    filePath,
    oldPath: null,
  };
}

async function getChangedFiles(
  cwd,
  mode,
  baseBranch,
  localCompareTarget = "HEAD",
) {
  if (!cwd) return { error: "No workspace folder open." };

  if (_isGitRepo === null) {
    const gitCheck = await run("git rev-parse --git-dir", cwd);
    _isGitRepo = gitCheck.ok;
  }
  if (!_isGitRepo) return { error: "Not a git repository." };

  const files = [];

  if (mode === "workingTree") {
    // HEAD와 비교할 때는 git status 사용
    if (localCompareTarget === "HEAD") {
      const res = await run("git status --porcelain", cwd);
      if (!res.ok) return { error: "git status failed: " + res.err };
      if (!res.out) return { files: [] };

      console.log("[DEBUG] git status output:");
      console.log(res.out);
      console.log("[DEBUG] Total lines:", res.out.split("\n").length);

      for (const line of res.out.split("\n")) {
        if (!line.trim()) continue;
        const x = line[0];
        const y = line[1];

        console.log(`[DEBUG] Line: "${line}" | X="${x}" Y="${y}"`);

        // ignored 파일만 제외
        if (x === "!") {
          console.log(`[DEBUG] Skipped (ignored)`);
          continue;
        }

        // 파일 경로는 XY 이후부터 (공백 제거)
        // "M  file.js" → "file.js"
        // " M file.js" → "file.js"
        // "?? file.js" → "file.js"
        const raw = line.substring(2).trimStart();
        let status = "M";

        // Untracked 파일
        if (x === "?") {
          status = "A"; // 추가된 파일로 표시
        }
        // Y(working tree)를 우선 체크, 없으면 X(staged)를 사용
        else if (y === "A" || (y === " " && x === "A")) status = "A";
        else if (y === "D" || (y === " " && x === "D")) status = "D";
        else if (y === "R" || (y === " " && x === "R")) status = "R";
        else if (y === "M" || (y === " " && x === "M")) status = "M";

        let filePath = raw.trim();
        let oldPath = null;
        if (status === "R" && raw.includes(" -> ")) {
          const parts = raw.split(" -> ");
          oldPath = parts[0].trim();
          filePath = parts[1].trim();
        }

        // 디렉토리인 경우 (끝에 / 있음) → 내부 파일들을 개별적으로 추가
        if (filePath.endsWith("/")) {
          const dirPath = filePath.slice(0, -1); // 마지막 / 제거

          try {
            // git ls-files를 사용하여 untracked 파일 목록 가져오기
            const { stdout } = await execAsync(
              `git ls-files --others --exclude-standard "${dirPath}"`,
              {
                cwd,
                maxBuffer: 1024 * 1024 * 10,
              },
            );

            const filesInDir = stdout.trim().split("\n").filter(Boolean);
            console.log(
              `[DEBUG] Found ${filesInDir.length} files in ${dirPath}`,
            );

            for (const relFile of filesInDir) {
              files.push({
                status,
                filePath: relFile,
                oldPath: null,
                category: extCategory(relFile),
              });
              console.log(`[DEBUG] Added (from dir): ${status} ${relFile}`);
            }
          } catch (err) {
            // 폴더 접근 실패 시 에러 자세히 로깅
            console.log(`[DEBUG] Cannot expand directory: ${dirPath}`);
            console.log(`[DEBUG] Error: ${err.message}`);
            files.push({
              status,
              filePath,
              oldPath,
              category: "ETC",
            });
          }
        } else {
          // 일반 파일
          files.push({
            status,
            filePath,
            oldPath,
            category: extCategory(filePath),
          });
          console.log(`[DEBUG] Added: ${status} ${filePath}`);
        }
      }
      console.log(`[DEBUG] Total files found: ${files.length}`);
      return { files, compareTarget: localCompareTarget };
    } else {
      // 다른 브랜치와 로컬 변경사항 비교
      // 1단계: git status로 변경된 파일 목록 가져오기
      const statusRes = await run("git status --porcelain", cwd);
      if (!statusRes.ok)
        return { error: "git status failed: " + statusRes.err };
      if (!statusRes.out)
        return { files: [], compareTarget: localCompareTarget };

      console.log(
        `[DEBUG] Comparing local changes against: ${localCompareTarget}`,
      );

      // 2단계: 각 변경된 파일을 처리
      for (const line of statusRes.out.split("\n")) {
        if (!line.trim()) continue;
        const x = line[0];
        const y = line[1];

        // ignored 파일 제외
        if (x === "!") continue;

        const raw = line.substring(2).trimStart();
        let filePath = raw.trim();
        let oldPath = null;

        // Rename 처리
        if (raw.includes(" -> ")) {
          const parts = raw.split(" -> ");
          oldPath = parts[0].trim();
          filePath = parts[1].trim();
        }

        // 디렉토리 확장
        if (filePath.endsWith("/")) {
          const dirPath = filePath.slice(0, -1);
          try {
            const { stdout } = await execAsync(
              `git ls-files --others --exclude-standard "${dirPath}"`,
              { cwd, maxBuffer: 1024 * 1024 * 10 },
            );
            const filesInDir = stdout.trim().split("\n").filter(Boolean);
            for (const relFile of filesInDir) {
              // 각 파일을 선택한 브랜치와 비교
              const fileStatus = await getFileStatusVsBranch(
                cwd,
                relFile,
                localCompareTarget,
              );
              if (fileStatus) {
                files.push({
                  ...fileStatus,
                  category: extCategory(relFile),
                });
              }
            }
          } catch (err) {
            console.log(`[DEBUG] Cannot expand directory: ${dirPath}`);
          }
          continue;
        }

        // 3단계: 파일이 선택한 브랜치에 있는지 확인
        const fileStatus = await getFileStatusVsBranch(
          cwd,
          filePath,
          localCompareTarget,
        );
        if (fileStatus) {
          files.push({
            ...fileStatus,
            category: extCategory(filePath),
          });
        }
      }

      console.log(`[DEBUG] Total files found: ${files.length}`);
      return { files, compareTarget: localCompareTarget };
    }
  }

  const base = baseBranch || "main";
  const res = await run("git diff --name-status " + base + "...HEAD", cwd);
  const src = res.ok ? res : await run("git diff --name-status " + base, cwd);

  if (!src.ok)
    return { error: `git diff failed. Is "${base}" a valid branch?` };
  if (!src.out) return { files: [], base };

  for (const line of src.out.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const status = (parts[0] || "M")[0];
    let filePath = (parts[parts.length - 1] || "").trim();
    let oldPath = null;
    if (status === "R" && parts.length >= 3) {
      oldPath = parts[1].trim();
      filePath = parts[2].trim();
    }
    if (filePath)
      files.push({
        status,
        filePath,
        oldPath,
        category: extCategory(filePath),
      });
  }

  return { files, base };
}

async function getPanelDiff(
  cwd,
  filePath,
  oldPath,
  status,
  mode,
  baseBranch,
  localTarget = "HEAD",
) {
  if (!cwd) return { diffText: "", error: "No workspace" };

  const safe = filePath.replace(/"/g, '\\"');
  const safeOld = (oldPath || filePath).replace(/"/g, '\\"');
  const base = baseBranch || "main";
  const target = localTarget || "HEAD";
  let res;

  if (status === "R") {
    if (mode === "workingTree") {
      // LOCAL 모드에서 rename 처리
      if (target === "HEAD") {
        res = await run(
          `git diff --no-ext-diff --unified=3 --find-renames HEAD -- "${safeOld}" "${safe}"`,
          cwd,
        );
      } else {
        res = await run(
          `git diff --no-ext-diff --unified=3 --find-renames ${target} -- "${safeOld}" "${safe}"`,
          cwd,
        );
      }
    } else {
      res = await run(
        `git diff --no-ext-diff --unified=3 --find-renames ${base}...HEAD -- "${safeOld}" "${safe}"`,
        cwd,
      );
    }
  } else if (mode === "workingTree") {
    // LOCAL 모드에서 일반 파일 처리
    if (target === "HEAD") {
      res = await run(`git diff --no-ext-diff --unified=3 -- "${safe}"`, cwd);
    } else {
      res = await run(
        `git diff --no-ext-diff --unified=3 ${target} -- "${safe}"`,
        cwd,
      );
    }
  } else {
    res = await run(
      `git diff --no-ext-diff --unified=3 ${base}...HEAD -- "${safe}"`,
      cwd,
    );
  }

  if (!res.ok) return { diffText: "", error: res.err || "git diff failed" };
  return { diffText: res.out || "", error: null };
}

// ── Editor Diff ───────────────────────────────────────────────────────────────

function findExistingDiffTab(absPath) {
  const normalizedPath = path.normalize(absPath);
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (
        input instanceof vscode.TabInputTextDiff &&
        input.modified &&
        input.modified.scheme === "file" &&
        path.normalize(input.modified.fsPath) === normalizedPath
      ) {
        return tab;
      }
    }
  }
  return null;
}

async function openEditorDiff(
  cwd,
  filePath,
  oldPath,
  status,
  mode,
  baseBranch,
  localTarget = "HEAD",
) {
  const base = baseBranch || "main";
  const target = localTarget || "HEAD";
  const absPath = path.join(cwd, filePath);
  const basename = path.basename(filePath);

  // 이미 열린 diff 탭 있으면 닫기 (중복 방지)
  const existing = findExistingDiffTab(absPath);
  if (existing) await vscode.window.tabGroups.close(existing);

  let leftUri;
  let rightUri;

  if (mode === "workingTree") {
    if (status === "A") {
      const emptyDoc = await vscode.workspace.openTextDocument({
        content: "",
        language: guessLanguage(filePath),
      });
      leftUri = emptyDoc.uri;
      rightUri = vscode.Uri.file(absPath);
    } else if (status === "D") {
      const emptyDoc = await vscode.workspace.openTextDocument({
        content: "",
        language: guessLanguage(filePath),
      });
      leftUri = makeGitUri(absPath, target);
      rightUri = emptyDoc.uri;
    } else {
      leftUri = makeGitUri(oldPath ? path.join(cwd, oldPath) : absPath, target);
      rightUri = vscode.Uri.file(absPath);
    }
  } else {
    if (status === "A") {
      const emptyDoc = await vscode.workspace.openTextDocument({
        content: "",
        language: guessLanguage(filePath),
      });
      leftUri = emptyDoc.uri;
      rightUri = vscode.Uri.file(absPath);
    } else if (status === "D") {
      const emptyDoc = await vscode.workspace.openTextDocument({
        content: "",
        language: guessLanguage(filePath),
      });
      leftUri = makeGitUri(path.join(cwd, filePath), base);
      rightUri = emptyDoc.uri;
    } else {
      leftUri = makeGitUri(
        status === "R" && oldPath ? path.join(cwd, oldPath) : absPath,
        base,
      );
      rightUri = vscode.Uri.file(absPath);
    }
  }

  await vscode.commands.executeCommand(
    "vscode.diff",
    leftUri,
    rightUri,
    `${basename} Diff`,
    {
      preview: false,
    },
  );
}

// ── WebviewViewProvider ───────────────────────────────────────────────────────

class PixelBranchDiffProvider {
  constructor(context) {
    this._context = context;
    this._view = null;
  }

  resolveWebviewView(webviewView) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(this._context.extensionPath, "media")),
      ],
    };

    webviewView.webview.html = buildHtml(
      webviewView.webview,
      this._context.extensionUri,
    );

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      const cwd = getCwd();
      let mode = _state.mode;
      let baseBranch = _state.baseBranch;

      if (!baseBranch && cwd) {
        baseBranch = await getDefaultBranch(cwd);
        _state.baseBranch = baseBranch;
      }

      if (msg.type === "ready" || msg.type === "refresh") {
        if (this._view) this._view.webview.postMessage({ type: "loading" });
        this._sendData(cwd, mode, baseBranch);
      } else if (msg.type === "getDiff") {
        const localTarget = _state.localCompareTarget || "HEAD";
        const diff = await getPanelDiff(
          cwd,
          msg.filePath,
          msg.oldPath,
          msg.status,
          mode,
          baseBranch,
          localTarget,
        );
        webviewView.webview.postMessage({
          type: "diffResult",
          filePath: msg.filePath,
          diffText: diff.diffText,
          diffError: diff.error,
        });
      } else if (msg.type === "openFile") {
        if (!cwd) return;
        try {
          const fileUri = vscode.Uri.file(path.join(cwd, msg.filePath));
          if (isImageFile(msg.filePath)) {
            await vscode.commands.executeCommand("vscode.open", fileUri, {
              preview: false,
            });
          } else {
            const doc = await vscode.workspace.openTextDocument(fileUri);
            await vscode.window.showTextDocument(doc, { preview: false });
          }
        } catch (err) {
          vscode.window.showErrorMessage(
            `Cannot open: ${msg.filePath}\nFull path: ${path.join(cwd, msg.filePath)}\nError: ${err.message}`,
          );
        }
      } else if (msg.type === "openEditorDiff") {
        if (!cwd) return;
        try {
          const localTarget = _state.localCompareTarget || "HEAD";
          await openEditorDiff(
            cwd,
            msg.filePath,
            msg.oldPath,
            msg.status,
            mode,
            baseBranch,
            localTarget,
          );
        } catch (e) {
          vscode.window.showErrorMessage(
            "Cannot open editor diff: " + String(e.message || e),
          );
        }
      } else if (msg.type === "setBaseBranch") {
        const res = await run("git branch --format=%(refname:short)", cwd);
        const reflog = await run(
          "git reflog show --pretty=format:%D HEAD -n 50",
          cwd,
        );
        const recentBranches = reflog.ok
          ? reflog.out
              .split("\n")
              .flatMap((line) => line.split(", "))
              .map((ref) => ref.replace("HEAD -> ", "").trim())
              .filter(
                (ref) => !ref.startsWith("origin/") && ref !== "HEAD" && ref,
              )
              .filter((b, i, arr) => arr.indexOf(b) === i)
          : [];
        const allLocal = res.ok
          ? res.out
              .split("\n")
              .map((b) => b.trim())
              .filter(Boolean)
          : [];
        const branches = [
          ...recentBranches,
          ...allLocal.filter((b) => !recentBranches.includes(b)),
        ];

        const picked = await vscode.window.showQuickPick(branches, {
          title: "Base Branch 선택",
          placeHolder: "비교 기준 브랜치를 선택하세요",
        });

        if (picked !== undefined) {
          if (this._view) this._view.webview.postMessage({ type: "loading" });
          _state.baseBranch = picked;
          await this._sendData(cwd, mode, picked);
        }
      } else if (msg.type === "setLocalTarget") {
        const res = await run("git branch --format=%(refname:short)", cwd);
        const reflog = await run(
          "git reflog show --pretty=format:%D HEAD -n 50",
          cwd,
        );
        const recentBranches = reflog.ok
          ? reflog.out
              .split("\n")
              .flatMap((line) => line.split(", "))
              .map((ref) => ref.replace("HEAD -> ", "").trim())
              .filter(
                (ref) => !ref.startsWith("origin/") && ref !== "HEAD" && ref,
              )
              .filter((b, i, arr) => arr.indexOf(b) === i)
          : [];
        const allBranches = res.ok
          ? res.out
              .split("\n")
              .map((b) => b.trim())
              .filter(Boolean)
          : [];
        const uniqueBranches = [
          ...new Set([...recentBranches, ...allBranches]),
        ];

        // HEAD를 맨 앞에 추가
        const options = ["HEAD", ...uniqueBranches];
        const picked = await vscode.window.showQuickPick(options, {
          title: "LOCAL 모드 비교 대상 선택",
          placeHolder: "현재 작업을 어떤 브랜치와 비교할까요?",
        });

        if (picked !== undefined) {
          if (this._view) this._view.webview.postMessage({ type: "loading" });
          _state.localCompareTarget = picked;
          await this._sendData(cwd, mode, baseBranch);
        }
      } else if (msg.type === "toggleMode") {
        const newMode = mode === "compareBase" ? "workingTree" : "compareBase";
        if (this._view) this._view.webview.postMessage({ type: "loading" });
        _state.mode = newMode;
        await this._sendData(cwd, newMode, baseBranch);
      }
    });

    setTimeout(() => this.refresh(), 600);
  }

  async _sendData(cwd, mode, baseBranch) {
    if (!this._view) return;

    const localTarget = _state.localCompareTarget || "HEAD";

    const [branch, result] = await Promise.all([
      cwd ? getCurrentBranch(cwd) : Promise.resolve("(no workspace)"),
      cwd
        ? getChangedFiles(cwd, mode, baseBranch, localTarget)
        : Promise.resolve({ error: "No workspace folder open." }),
    ]);

    this._view.webview.postMessage({
      type: "data",
      branch,
      mode,
      baseBranch: baseBranch || "main",
      localTarget: localTarget,
      ...result,
    });
  }

  async refresh() {
    if (!this._view) return;
    const cwd = getCwd();

    if (!_state.baseBranch && cwd) {
      const detectedBase = await getDefaultBranch(cwd);
      if (detectedBase) _state.baseBranch = detectedBase;
    }

    if (!_state.localCompareTarget) {
      _state.localCompareTarget = "HEAD";
    }

    this._view.webview.postMessage({ type: "loading" });
    await this._sendData(cwd, _state.mode, _state.baseBranch);
  }
}
// ── HTML Builder ──────────────────────────────────────────────────────────────

function buildHtml(webview, extensionUri) {
  const nonce = getNonce();
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "media", "webview.js"),
  );

  const CSS = [
    "*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}",
    ":root{",
    "  --bg:var(--vscode-editor-background);",
    "  --fg:var(--vscode-editor-foreground);",
    "  --border:var(--vscode-panel-border,#3c3c3c);",
    "  --btn-bg:var(--vscode-button-background);",
    "  --btn-fg:var(--vscode-button-foreground,#fff);",
    "  --ins:var(--vscode-diffEditor-insertedLineBackground,rgba(0,200,80,.15));",
    "  --del:var(--vscode-diffEditor-removedLineBackground,rgba(200,50,50,.15));",
    "  --hover:var(--vscode-list-hoverBackground,rgba(255,255,255,.05));",
    "  --accent:var(--vscode-textLink-foreground,#4fc1ff);",
    "  --c-add:var(--vscode-gitDecoration-addedResourceForeground,#4ade80);",
    "  --c-del:var(--vscode-gitDecoration-deletedResourceForeground,#f87171);",
    "  --c-mod:var(--vscode-gitDecoration-modifiedResourceForeground,#e6b432);",
    "  --c-ren:#9b91e8;",
    '  --mono:var(--vscode-editor-font-family,"Courier New",monospace);',
    "  --ui:var(--vscode-font-family,sans-serif);",
    "  --fs:var(--vscode-font-size,12px);",
    "  --r:3px;",
    "}",
    "body{font-family:var(--ui);font-size:var(--fs);color:var(--fg);background:var(--bg);height:100vh;overflow:hidden;display:flex;flex-direction:column}",
    ".btn{display:inline-flex;align-items:center;gap:4px;padding:2px 7px;font-size:10px;font-family:var(--mono);font-weight:700;letter-spacing:.04em;text-transform:uppercase;background:var(--btn-bg);color:var(--btn-fg);border:2px solid transparent;border-radius:var(--r);cursor:pointer;outline:none;transition:opacity .1s,transform .08s;white-space:nowrap;box-shadow:2px 2px 0 rgba(0,0,0,.35);user-select:none}",
    ".btn:hover{opacity:.85;transform:translateY(-1px)}",
    ".btn:active{transform:translateY(1px);box-shadow:1px 1px 0 rgba(0,0,0,.35)}",
    ".btn.ghost{background:transparent;border-color:var(--border);color:var(--fg);box-shadow:1px 1px 0 rgba(0,0,0,.2)}",
    ".btn.ghost:hover{border-color:var(--accent);color:var(--accent)}",
    ".btn.active-pill{background:var(--accent)!important;color:var(--bg)!important;border-color:var(--accent)!important}",
    ".btn.sm{padding:1px 5px;font-size:10px}",
    ".btn .ico{font-size:10px;line-height:1;opacity:.9}",
    "#toolbar{padding:5px 8px 4px;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:5px;flex-shrink:0}",
    "#branch-row{display:flex;align-items:center;gap:5px;font-size:10px;font-family:var(--mono);flex-wrap:wrap}",
    ".tag{display:inline-flex;align-items:center;gap:3px;padding:1px 6px;color:var(--accent);border-radius:var(--r);font-size:10px;font-family:var(--mono);background:color-mix(in srgb,currentColor 12%,transparent);border:1px solid color-mix(in srgb,currentColor 35%,transparent);font-weight:700}",
    ".tag-base{display:inline-flex;align-items:center;gap:4px;padding:1px 6px;background:transparent;color:var(--fg);border-radius:var(--r);font-size:10px;font-family:var(--mono);border:1px dashed var(--border);cursor:pointer;opacity:.75;transition:opacity .1s,border-color .1s,color .1s}",
    ".tag-base:hover{opacity:1;border-color:var(--accent);color:var(--accent)}",
    "#pills{display:flex;flex-wrap:wrap;gap:3px}",
    "#action-row{display:flex;gap:4px;align-items:center;flex-wrap:wrap}",
    "#mascot{padding:6px 8px 4px;display:flex;align-items:center;gap:7px;border-bottom:1px solid var(--border);flex-shrink:0;position:relative;overflow:hidden}",
    "#mascot .dots{position:absolute;right:0;top:0;width:50px;height:100%;background-image:radial-gradient(circle,var(--border) 1px,transparent 1px);background-size:6px 6px;opacity:.3;pointer-events:none}",
    ".m-text{font-size:10px;font-family:var(--mono);opacity:.85;line-height:1.5}",
    ".m-count{font-size:10px;font-family:var(--mono);font-weight:bold;color:var(--accent)}",
    "#main{display:flex;flex:1;min-height:0;overflow:hidden}",
    "#file-panel{width:100%;display:flex;flex-direction:column;border-right:1px solid var(--border);min-height:0;transition:width .2s}",
    "#main.diff-open #file-panel{width:40%;min-width:120px}",
    "#file-scroll{flex:1;overflow-y:auto;overflow-x:hidden;padding:4px 0}",
    "#file-scroll::-webkit-scrollbar{width:4px}",
    "#file-scroll::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}",
    ".fi{display:flex;align-items:flex-start;padding:6px 8px;cursor:pointer;border-left:2px solid transparent;gap:8px;transition:background .08s}",
    ".fi:hover{background:var(--hover)}",
    ".fi.sel{background:var(--hover);border-left-color:var(--accent)}",
    ".fi-checkbox-wrapper{display:flex;align-items:center;padding-top:2px}",
    ".file-checkbox{appearance:none;width:16px;height:16px;border:1px solid var(--vscode-checkbox-border);border-radius:3px;cursor:pointer;position:relative;transition:all .15s;flex-shrink:0;background:var(--vscode-checkbox-background)}",
    ".file-checkbox:hover{border-color:var(--vscode-checkbox-border)}",
    ".file-checkbox:checked{background:var(--vscode-checkbox-selectBackground);border-color:var(--vscode-checkbox-selectBorder)}",
    ".file-checkbox:checked::after{content:'';position:absolute;left:4.5px;top:1px;width:4px;height:8px;border:solid var(--vscode-checkbox-foreground);border-width:0 2px 2px 0;transform:rotate(45deg)}",
    ".fi-content{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}",
    ".fi-top{display:flex;align-items:center;gap:4px;min-width:0}",
    ".sbadge{font-size:10px;font-family:var(--mono);font-weight:900;padding:0 4px;border-radius:2px;flex-shrink:0;line-height:14px;height:14px;display:inline-flex;align-items:center;background:color-mix(in srgb,currentColor 20%,transparent);border:1px solid color-mix(in srgb,currentColor 45%,transparent)}",
    ".s-M{color:var(--c-mod)}",
    ".s-A{color:var(--c-add)}",
    ".s-D{color:var(--c-del)}",
    ".s-R{color:var(--c-ren)}",
    ".fname{font-size:11px;font-family:var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}",
    ".fdir{font-size:10px;opacity:.5;font-family:var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-left:2px}",
    ".cat{font-size:10px;padding:0 4px;border-radius:2px;font-family:var(--mono);border:1px solid var(--border);opacity:.6;text-transform:uppercase;line-height:13px;flex-shrink:0}",
    ".fi-actions{display:none;gap:4px;align-items:center;margin-top:1px;padding-left:2px;flex-wrap:wrap}",
    ".fi:hover .fi-actions,.fi.sel .fi-actions{display:flex}",
    "#diff-panel{display:none;flex-direction:column;flex:1;min-width:0;min-height:0}",
    "#main.diff-open #diff-panel{display:flex}",
    "#diff-header{padding:5px 8px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:6px;flex-shrink:0;flex-wrap:wrap}",
    ".dh-status{font-size:10px;font-family:var(--mono);text-transform:uppercase;padding:1px 5px;border-radius:2px;flex-shrink:0;background:color-mix(in srgb,currentColor 15%,transparent);border:1px solid color-mix(in srgb,currentColor 35%,transparent)}",
    ".dh-status-M{color:var(--c-mod)}",
    ".dh-status-A{color:var(--c-add)}",
    ".dh-status-D{color:var(--c-del)}",
    ".dh-status-R{color:var(--c-ren)}",
    ".dh-counts{display:flex;gap:4px;font-size:10px;font-family:var(--mono)}",
    ".dh-add{color:var(--c-add)}",
    ".dh-del{color:var(--c-del)}",
    ".rename-box{display:flex;align-items:stretch;margin:0 8px 6px;border:1px solid var(--border);border-radius:var(--r);overflow:hidden;font-size:10px;font-family:var(--mono)}",
    ".rename-side{flex:1;padding:4px 7px;min-width:0}",
    ".rename-side--from{border-right:1px solid var(--border)}",
    ".rename-label{font-size:9px;opacity:.5;margin-bottom:2px}",
    ".rename-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".rename-dir{display:none}",
    ".rename-name--del{color:var(--c-del);text-decoration:line-through;opacity:.8}",
    ".rename-name--add{color:var(--c-add);font-weight:700}",
    ".rename-arrow{display:flex;align-items:center;padding:0 5px;opacity:.35;font-size:11px;flex-shrink:0}",
    "#diff-scroll{flex:1;overflow:auto}",
    "#diff-scroll::-webkit-scrollbar{width:5px;height:5px}",
    "#diff-scroll::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}",
    "#diff-scroll::-webkit-scrollbar-corner{background:transparent}",
    ".d-info{padding:20px 12px;font-size:11px;font-family:var(--mono);opacity:.7;text-align:center}",
    ".d-err{color:var(--c-del)}",
    ".dt{border-collapse:collapse;table-layout:auto;min-width:100%}",
    '.dt td{vertical-align:top;padding:0 6px;white-space:pre;font-size:11px;font-family:var(--mono,"Courier New",monospace)}',
    ".dt .ln{width:32px;min-width:32px;text-align:right;opacity:.35;user-select:none;padding-right:5px;padding-left:4px;border-right:1px solid var(--border);font-size:10px;white-space:nowrap!important}",
    ".dt tr.ins td{background:var(--ins)}",
    ".dt tr.del td{background:var(--del)}",
    ".dt tr.hunk td{background:color-mix(in srgb,var(--accent) 8%,transparent);color:var(--accent);font-size:10px;padding:1px 8px;border-top:1px solid var(--border);border-bottom:1px solid var(--border)}",
    ".dsign{width:14px;min-width:14px;text-align:center;padding:0 2px;user-select:none;white-space:nowrap!important}",
    "tr.ins .dsign{color:var(--c-add)}",
    "tr.del .dsign{color:var(--c-del)}",
    ".dt.wrap{min-width:unset;width:100%}",
    ".dt.wrap td:last-child{white-space:pre-wrap!important;word-break:break-all;overflow-wrap:anywhere}",
    "#empty-state{padding:24px 12px;text-align:center;font-size:11px;font-family:var(--mono);opacity:.6;line-height:1.8}",
    "#err-box{padding:10px 12px;font-size:11px;font-family:var(--mono);color:#dc5050;background:rgba(220,80,80,.08);border:1px solid rgba(220,80,80,.2);border-radius:var(--r);margin:8px;line-height:1.6}",
    "#search-row{display:flex;gap:6px;margin-top:8px;align-items:center}",
    "#select-all-wrapper{display:flex;align-items:center;gap:4px;padding:0 4px}",
    "#select-all{appearance:none;width:16px;height:16px;border:1px solid var(--vscode-checkbox-border);border-radius:3px;cursor:pointer;position:relative;transition:all .15s;background:var(--vscode-checkbox-background)}",
    "#select-all:hover{border-color:var(--vscode-checkbox-border)}",
    "#select-all:checked{background:var(--vscode-checkbox-selectBackground);border-color:var(--vscode-checkbox-selectBorder)}",
    "#select-all:checked::after{content:'';position:absolute;left:4.5px;top:1px;width:4px;height:8px;border:solid var(--vscode-checkbox-foreground);border-width:0 2px 2px 0;transform:rotate(45deg)}",
    "#select-count{font-size:10px;font-family:var(--mono);color:var(--fg);opacity:.6}",
    "#search-input{flex:1;padding:5px 8px;font-size:12px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1.5px solid var(--border);border-radius:var(--r);font-family:var(--mono)}",
    "#search-input::placeholder{color:var(--vscode-input-placeholderForeground);opacity:.8}",
    "#search-input:focus{outline:1px solid var(--accent);outline-offset:-1px}",
    ".action-btn{padding:5px 12px;font-size:11px;font-weight:600;border:1px solid var(--accent);background:var(--accent);color:var(--vscode-button-foreground,#fff);border-radius:var(--r);cursor:pointer;font-family:var(--mono);transition:all .15s;white-space:nowrap}",
    ".action-btn:hover{background:var(--vscode-button-hoverBackground,var(--accent));opacity:.9}",
    ".action-btn:active{transform:scale(.98)}",
    ".action-btn:disabled{opacity:.4;cursor:not-allowed}",
    ".fname mark{background:var(--vscode-editor-findMatchHighlightBackground,rgba(234,92,0,.33));color:inherit;padding:0;border-radius:2px}",
    ".fdir mark{background:var(--vscode-editor-findMatchHighlightBackground,rgba(234,92,0,.33));color:inherit;padding:0;border-radius:2px}",
    ".spin{display:inline-block;width:10px;height:10px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:sp .7s linear infinite;vertical-align:middle}",
    "@keyframes sp{to{transform:rotate(360deg)}}",
  ].join("\n");

  const MASCOT =
    '<svg width="28" height="28" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" style="flex-shrink:0;image-rendering:pixelated">' +
    '<rect x="2" y="1" width="2" height="3" fill="var(--accent)"/>' +
    '<rect x="3" y="2" width="1" height="1" fill="var(--bg)" opacity="0.6"/>' +
    '<rect x="14" y="1" width="2" height="3" fill="var(--accent)"/>' +
    '<rect x="14" y="2" width="1" height="1" fill="var(--bg)" opacity="0.6"/>' +
    '<rect x="2" y="4" width="14" height="9" rx="1" fill="var(--accent)" opacity="0.9"/>' +
    '<rect x="5" y="7" width="2" height="1" fill="var(--bg)"/>' +
    '<rect x="11" y="7" width="2" height="1" fill="var(--bg)"/>' +
    '<rect x="8" y="9" width="2" height="1" fill="var(--bg)" opacity="0.7"/>' +
    '<rect x="7" y="10" width="1" height="1" fill="var(--bg)" opacity="0.5"/>' +
    '<rect x="10" y="10" width="1" height="1" fill="var(--bg)" opacity="0.5"/>' +
    '<rect x="1" y="9" width="3" height="1" fill="var(--fg)" opacity="0.3"/>' +
    '<rect x="0" y="10" width="4" height="1" fill="var(--fg)" opacity="0.2"/>' +
    '<rect x="14" y="9" width="3" height="1" fill="var(--fg)" opacity="0.3"/>' +
    '<rect x="14" y="10" width="4" height="1" fill="var(--fg)" opacity="0.2"/>' +
    '<rect x="4" y="13" width="10" height="4" rx="1" fill="var(--accent)" opacity="0.75"/>' +
    '<rect x="7" y="14" width="4" height="2" fill="var(--bg)" opacity="0.2"/>' +
    "</svg>";

  return (
    "<!DOCTYPE html>\n" +
    '<html lang="en">\n' +
    "<head>\n" +
    '<meta charset="UTF-8">\n' +
    '<meta name="viewport" content="width=device-width,initial-scale=1.0">\n' +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};">\n` +
    "<title>Pixel Branch Diff</title>\n" +
    "<style>" +
    CSS +
    "</style>\n" +
    "</head>\n" +
    "<body>\n" +
    '<div id="toolbar">\n' +
    '  <div id="branch-row">\n' +
    '    <button class="btn ghost sm" id="btn-mode" title="Toggle: compare branch vs working tree changes"><span class="ico">&#x21CC;</span>BRANCH</button>\n' +
    '    <span class="tag" id="t-branch">...</span>\n' +
    '    <span style="opacity:.4;font-size:10px" id="vs-sep">vs</span>\n' +
    '    <span class="tag-base" id="t-base" title="Click to change base branch">&#x270E; main</span>\n' +
    '    <span class="tag-base" id="t-local-target" style="display:none" title="Click to change compare target">&#x270E; HEAD</span>\n' +
    "  </div>\n" +
    '<div id="mascot">\n' +
    MASCOT +
    "\n" +
    '  <div class="m-text"><span id="m-msg">scanning...</span><br><span class="m-count" id="m-count">0 files</span></div>\n' +
    '  <div class="dots"></div>\n' +
    "</div>\n" +
    '  <div id="action-row">\n' +
    '    <div id="pills"></div>\n' +
    '    <div style="flex:1"></div>\n' +
    "  </div>\n" +
    '  <div id="search-row">\n' +
    '    <div id="select-all-wrapper">\n' +
    '      <input type="checkbox" id="select-all" title="Select all filtered files" />\n' +
    '      <span id="select-count"></span>\n' +
    "    </div>\n" +
    '    <input type="text" id="search-input" placeholder="Search files..." />\n' +
    '    <button class="action-btn" id="btn-open-selected" title="Open selected files">Open</button>\n' +
    "  </div>\n" +
    "</div>\n" +
    '<div id="main">\n' +
    '  <div id="file-panel"><div id="file-scroll"><div id="file-list"></div></div></div>\n' +
    '  <div id="diff-panel">\n' +
    '    <div id="diff-header">\n' +
    '      <span id="dh-status" class="dh-status dh-status-M">MODIFIED</span>\n' +
    '      <span class="dh-counts"><span id="dh-add" class="dh-add">+0</span><span id="dh-del" class="dh-del">-0</span></span>\n' +
    '      <div style="flex:1"></div>\n' +
    '      <button class="btn ghost sm" id="btn-wrap" title="Toggle line wrap">WRAP</button>\n' +
    '      <button class="btn ghost sm" id="btn-close"><span class="ico">&#x2715;</span></button>\n' +
    "    </div>\n" +
    '    <div id="rename-row" style="display:none"></div>\n' +
    '    <div id="diff-scroll"><div id="diff-body"></div></div>\n' +
    "  </div>\n" +
    "</div>\n" +
    `<script nonce="${nonce}" src="${scriptUri}"></script>\n` +
    "</body>\n" +
    "</html>"
  );
}

// ── Extension entry point ─────────────────────────────────────────────────────

function activate(context) {
  const provider = new PixelBranchDiffProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "pixelBranchDiff.explorerView",
      provider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pixelBranchDiff.refresh", () =>
      provider.refresh(),
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "pixelBranchDiff.setBaseBranch",
      async () => {
        const cwd = getCwd();
        const config = vscode.workspace.getConfiguration("pixelBranchDiff");
        const res = await run("git branch --format=%(refname:short)", cwd);
        const branches = res.ok
          ? res.out
              .split("\n")
              .map((b) => b.trim())
              .filter(Boolean)
          : [];
        const current =
          config.get("baseBranch") || (await getDefaultBranch(cwd));
        const picked = await vscode.window.showQuickPick(branches, {
          title: "Base Branch 선택",
          placeHolder: "비교 기준 브랜치를 선택하세요",
          activeItems: [current],
        });
        if (picked !== undefined) {
          await config.update(
            "baseBranch",
            picked,
            vscode.ConfigurationTarget.Workspace,
          );
          provider.refresh();
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "pixelBranchDiff.setLocalTarget",
      async () => {
        const cwd = getCwd();
        const config = vscode.workspace.getConfiguration("pixelBranchDiff");
        const res = await run("git branch --format=%(refname:short)", cwd);
        const branches = res.ok
          ? res.out
              .split("\n")
              .map((b) => b.trim())
              .filter(Boolean)
          : [];

        // HEAD 옵션 추가
        const options = ["HEAD", ...branches];
        const current = config.get("localCompareTarget") || "HEAD";

        const picked = await vscode.window.showQuickPick(options, {
          title: "LOCAL 모드 비교 대상 선택",
          placeHolder: "어떤 브랜치와 비교할까요?",
          activeItems: [current],
        });

        if (picked !== undefined) {
          await config.update(
            "localCompareTarget",
            picked,
            vscode.ConfigurationTarget.Workspace,
          );
          provider.refresh();
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pixelBranchDiff.toggleMode", async () => {
      const config = vscode.workspace.getConfiguration("pixelBranchDiff");
      const newMode =
        config.get("mode", "compareBase") === "compareBase"
          ? "workingTree"
          : "compareBase";
      await config.update(
        "mode",
        newMode,
        vscode.ConfigurationTarget.Workspace,
      );
      provider.refresh();
    }),
  );

  const watcher = vscode.workspace.createFileSystemWatcher("**/.git/index");
  const debouncedRefresh = () => {
    if (_refreshTimer) clearTimeout(_refreshTimer);
    _refreshTimer = setTimeout(() => provider.refresh(), 300);
  };
  watcher.onDidChange(debouncedRefresh);
  watcher.onDidCreate(debouncedRefresh);
  context.subscriptions.push(watcher);
}

function deactivate() {}

module.exports = { activate, deactivate };
