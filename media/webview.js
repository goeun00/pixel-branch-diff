(function () {
  var vscode = acquireVsCodeApi();

  var state = {
    files: [],
    filter: "ALL",
    searchText: "",
    selectedFiles: [],
    sel: null,
    mode: "compareBase",
    base: "main",
    branch: "...",
    localTarget: "HEAD",
    diffOpen: false,
    error: null,
  };

  function getCategoryCounts(files) {
    var counts = { ALL: files.length };
    files.forEach(function (f) {
      var cat = f.category || "ETC";
      counts[cat] = (counts[cat] || 0) + 1;
    });
    return counts;
  }

  function getFilteredFiles() {
    return state.files.filter(function (f) {
      // 카테고리 필터
      var categoryMatch = state.filter === "ALL" || f.category === state.filter;

      // 검색어 필터
      var searchMatch = true;
      if (state.searchText) {
        var fileName = f.filePath.toLowerCase();
        searchMatch = fileName.indexOf(state.searchText) !== -1;
      }

      return categoryMatch && searchMatch;
    });
  }

  function highlightText(text, searchText) {
    if (!searchText) return esc(text);

    var lowerText = text.toLowerCase();
    var lowerSearch = searchText.toLowerCase();
    var result = "";
    var lastIndex = 0;
    var index = lowerText.indexOf(lowerSearch);

    while (index !== -1) {
      result += esc(text.substring(lastIndex, index));
      result +=
        "<mark>" +
        esc(text.substring(index, index + searchText.length)) +
        "</mark>";
      lastIndex = index + searchText.length;
      index = lowerText.indexOf(lowerSearch, lastIndex);
    }

    result += esc(text.substring(lastIndex));
    return result;
  }

  var wrapOn = false;
  var pillsEl = document.getElementById("pills");
  var PILLS = ["ALL", "MARKUP", "JS", "JSX", "CSS", "IMG", "ETC"];

  function renderPills() {
    var counts = getCategoryCounts(state.files || []);

    pillsEl.innerHTML = "";

    PILLS.forEach(function (p) {
      if (p !== "ALL" && !counts[p]) return;

      var b = document.createElement("button");
      b.className = "btn ghost sm" + (p === state.filter ? " active-pill" : "");
      b.dataset.pill = p;

      var count = counts[p] || 0;
      b.textContent = p + "(" + count + ")";

      b.onclick = function () {
        state.filter = p;

        document.querySelectorAll("[data-pill]").forEach(function (el) {
          el.classList.toggle("active-pill", el.dataset.pill === p);
        });

        renderFiles();
      };

      pillsEl.appendChild(b);
    });
  }

  document.getElementById("btn-mode").onclick = function () {
    vscode.postMessage({ type: "toggleMode" });
  };

  document.getElementById("t-base").onclick = function () {
    vscode.postMessage({ type: "setBaseBranch" });
  };

  document.getElementById("t-local-target").onclick = function () {
    vscode.postMessage({ type: "setLocalTarget" });
  };

  document.getElementById("search-input").oninput = function (e) {
    state.searchText = e.target.value.toLowerCase();
    renderFiles();
  };

  document.getElementById("select-all").onchange = function (e) {
    var filtered = getFilteredFiles();

    if (e.target.checked) {
      // 전체 선택
      filtered.forEach(function (f) {
        if (state.selectedFiles.indexOf(f.filePath) === -1) {
          state.selectedFiles.push(f.filePath);
        }
      });
    } else {
      // 전체 해제 (필터된 파일만)
      filtered.forEach(function (f) {
        var idx = state.selectedFiles.indexOf(f.filePath);
        if (idx !== -1) {
          state.selectedFiles.splice(idx, 1);
        }
      });
    }

    renderFiles();
  };

  document.getElementById("btn-open-selected").onclick = function () {
    if (!state.selectedFiles.length) return;

    state.selectedFiles.forEach(function (filePath) {
      vscode.postMessage({ type: "openFile", filePath: filePath });
    });
  };

  document.getElementById("btn-close").onclick = closeDiff;

  document.getElementById("btn-wrap").onclick = function () {
    wrapOn = !wrapOn;
    var btn = document.getElementById("btn-wrap");
    var table = document.querySelector("#diff-body .dt");
    if (table) table.classList.toggle("wrap", wrapOn);
    btn.classList.toggle("active-pill", wrapOn);
    btn.textContent = wrapOn ? "WRAP ON" : "WRAP";
  };

  function esc(s) {
    if (s == null) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function closeDiff() {
    state.diffOpen = false;
    state.sel = null;
    document.getElementById("main").classList.remove("diff-open");
    renderFiles();
  }

  function renderFiles() {
    var list = document.getElementById("file-list");
    list.innerHTML = "";

    if (state.error) {
      var e = document.createElement("div");
      e.id = "err-box";
      e.textContent = state.error;
      list.appendChild(e);
      return;
    }

    var filtered = getFilteredFiles();

    if (!filtered.length) {
      var d = document.createElement("div");
      d.id = "empty-state";

      if (state.searchText) {
        d.innerHTML =
          '<div style="font-size:22px;margin-bottom:8px">&#128269;</div>' +
          'No files match "' +
          esc(state.searchText) +
          '"';
      } else {
        d.innerHTML =
          '<div style="font-size:22px;margin-bottom:8px">&#11035;</div>' +
          (state.files.length
            ? "No " + state.filter + " files changed."
            : "No changes on this branch.");
      }
      list.appendChild(d);
      return;
    }

    filtered.forEach(function (f) {
      var item = document.createElement("div");
      var isSel = state.sel && state.sel.filePath === f.filePath;
      var isChecked = state.selectedFiles.indexOf(f.filePath) !== -1;
      item.className = "fi" + (isSel ? " sel" : "");

      var basename = f.filePath.split("/").pop();
      var dir = f.filePath.split("/").slice(0, -1).join("/");
      var renameText = "";

      if (f.status === "R" && f.oldPath) {
        renameText = f.oldPath + " → " + f.filePath;
      }

      // 하이라이트 적용
      var highlightedBasename = highlightText(basename, state.searchText);
      var highlightedDir = highlightText(dir, state.searchText);
      var highlightedRename = highlightText(renameText, state.searchText);

      item.innerHTML =
        '<div class="fi-checkbox-wrapper">' +
        '<input type="checkbox" class="file-checkbox" ' +
        (isChecked ? "checked" : "") +
        ' data-path="' +
        esc(f.filePath) +
        '" />' +
        "</div>" +
        '<div class="fi-content">' +
        '<div class="fi-top">' +
        '<span class="sbadge s-' +
        esc(f.status) +
        '">' +
        esc(f.status) +
        "</span>" +
        '<span class="fname" title="' +
        esc(f.filePath) +
        '">' +
        highlightedBasename +
        "</span>" +
        '<span class="cat">' +
        esc(f.category) +
        "</span>" +
        "</div>" +
        (renameText
          ? '<div class="fdir fdir--rename">' + highlightedRename + "</div>"
          : dir
            ? '<div class="fdir">' + highlightedDir + "</div>"
            : "") +
        '<div class="fi-actions">' +
        '<button class="btn ghost sm" data-a="diff"><span class="ico">&#8800;</span><span>Diff</span></button>' +
        '<button class="btn ghost sm" data-a="editorDiff"><span class="ico">&#x2197;</span><span>Editor</span></button>' +
        "</div>" +
        "</div>";

      // 체크박스 이벤트
      var checkbox = item.querySelector(".file-checkbox");
      checkbox.addEventListener("click", function (ev) {
        ev.stopPropagation();
        var path = this.dataset.path;
        var idx = state.selectedFiles.indexOf(path);

        if (this.checked && idx === -1) {
          state.selectedFiles.push(path);
        } else if (!this.checked && idx !== -1) {
          state.selectedFiles.splice(idx, 1);
        }
      });

      item.addEventListener("click", function (ev) {
        if (
          ev.target.closest("[data-a]") ||
          ev.target.closest(".file-checkbox")
        )
          return;
        vscode.postMessage({ type: "openFile", filePath: f.filePath });
      });

      item.querySelectorAll("[data-a]").forEach(function (btn) {
        btn.addEventListener("click", function (ev) {
          ev.stopPropagation();
          var a = btn.getAttribute("data-a");

          if (a === "diff") {
            var isSame =
              state.diffOpen && state.sel && state.sel.filePath === f.filePath;

            if (isSame) {
              closeDiff();
            } else {
              loadDiff(f);
            }
          }

          if (a === "editorDiff") {
            vscode.postMessage({
              type: "openEditorDiff",
              filePath: f.filePath,
              oldPath: f.oldPath || null,
              status: f.status,
            });
          }
        });
      });

      list.appendChild(item);
    });

    // 전체선택 체크박스 상태 및 카운트 업데이트
    var selectAllCheckbox = document.getElementById("select-all");
    var selectCountEl = document.getElementById("select-count");

    if (selectAllCheckbox && filtered.length > 0) {
      var selectedCount = filtered.filter(function (f) {
        return state.selectedFiles.indexOf(f.filePath) !== -1;
      }).length;

      var allChecked = selectedCount === filtered.length;
      selectAllCheckbox.checked = allChecked;

      // 카운트 표시
      if (selectCountEl) {
        selectCountEl.textContent = selectedCount + "/" + filtered.length;
      }
    } else if (selectCountEl) {
      selectCountEl.textContent = "";
    }
  }

  function loadDiff(f) {
    state.sel = f;
    state.diffOpen = true;
    document.getElementById("main").classList.add("diff-open");

    document.getElementById("diff-body").innerHTML =
      '<div class="d-info"><span class="spin"></span> loading...</div>';

    var renameRow = document.getElementById("rename-row");
    if (renameRow) renameRow.style.display = "none";

    renderFiles();

    vscode.postMessage({
      type: "getDiff",
      filePath: f.filePath,
      oldPath: f.oldPath || null,
      status: f.status,
    });
  }
  function renderUnifiedDiff(diffText) {
    var body = document.getElementById("diff-body");
    if (!body) return;

    var selected = state.sel || {};
    var filePath = selected.filePath || "";
    var oldPath = selected.oldPath || "";
    var status = selected.status || "M";

    var lines = diffText ? diffText.split("\n") : [];
    var addCount = 0;
    var delCount = 0;
    lines.forEach(function (line) {
      if (line.startsWith("+") && !line.startsWith("+++")) addCount += 1;
      if (line.startsWith("-") && !line.startsWith("---")) delCount += 1;
    });

    var isModified = addCount > 0 || delCount > 0;

    var visibleLines = lines.filter(function (line) {
      return !(
        line.startsWith("diff --git") ||
        line.startsWith("index ") ||
        line.startsWith("similarity index ") ||
        line.startsWith("rename from ") ||
        line.startsWith("rename to ") ||
        line.startsWith("--- ") ||
        line.startsWith("+++ ")
      );
    });

    var hasVisibleDiff = visibleLines.some(function (line) {
      return (
        line.startsWith("@@") ||
        line.startsWith("+") ||
        line.startsWith("-") ||
        line.startsWith(" ")
      );
    });

    var statusText =
      status === "A"
        ? "ADDED"
        : status === "D"
          ? "DELETED"
          : status === "R"
            ? isModified
              ? "RENAMED+MOD"
              : "RENAMED"
            : "MODIFIED";

    var statusCls =
      "dh-status dh-status-" +
      (status === "R"
        ? "R"
        : status === "A"
          ? "A"
          : status === "D"
            ? "D"
            : "M");

    var dhStatus = document.getElementById("dh-status");
    var dhAdd = document.getElementById("dh-add");
    var dhDel = document.getElementById("dh-del");
    var renameRow = document.getElementById("rename-row");

    if (dhStatus) {
      dhStatus.textContent = statusText;
      dhStatus.className = statusCls;
    }
    if (dhAdd) dhAdd.textContent = "+" + addCount;
    if (dhDel) dhDel.textContent = "-" + delCount;

    if (status === "R" && renameRow) {
      var fromDir = oldPath ? oldPath.split("/").slice(0, -1).join("/") : "";
      var fromName = oldPath ? oldPath.split("/").pop() : "";
      var toDir = filePath.split("/").slice(0, -1).join("/");
      var toName = filePath.split("/").pop();
      renameRow.style.display = "";
      renameRow.innerHTML =
        '<div class="rename-box">' +
        '<div class="rename-side rename-side--from">' +
        '<div class="rename-label">FROM</div>' +
        '<div class="rename-path"><span class="rename-dir">' +
        esc(fromDir ? fromDir + "/" : "") +
        "</span>" +
        '<span class="rename-name--del">' +
        esc(fromName) +
        "</span></div>" +
        "</div>" +
        '<div class="rename-arrow">&#8594;</div>' +
        '<div class="rename-side">' +
        '<div class="rename-label">TO</div>' +
        '<div class="rename-path"><span class="rename-dir">' +
        esc(toDir ? toDir + "/" : "") +
        "</span>" +
        '<span class="rename-name--add">' +
        esc(toName) +
        "</span></div>" +
        "</div>" +
        "</div>";
    } else if (renameRow) {
      renameRow.style.display = "none";
      renameRow.innerHTML = "";
    }

    if (status === "R" && !hasVisibleDiff) {
      body.innerHTML =
        '<div class="d-info">File renamed without changes.</div>';
      return;
    }

    if (!diffText) {
      body.innerHTML =
        '<div class="d-info" style="opacity:.5">No text diff. Rename, image, or metadata-only change.</div>';
      return;
    }

    var html = '<table class="dt"><tbody>';
    var baseLine = 0;
    var headLine = 0;

    lines.forEach(function (line) {
      if (
        line.startsWith("diff --git") ||
        line.startsWith("index ") ||
        line.startsWith("similarity index ") ||
        line.startsWith("rename from ") ||
        line.startsWith("rename to ") ||
        line.startsWith("--- ") ||
        line.startsWith("+++ ")
      )
        return;

      if (line.startsWith("@@")) {
        var match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (match) {
          baseLine = parseInt(match[1], 10);
          headLine = parseInt(match[2], 10);
        }
        html +=
          '<tr class="hunk"><td class="ln" colspan="4">' +
          esc(line) +
          "</td></tr>";
        return;
      }

      var cls = "ctx";
      var sign = "";
      var leftNum = "";
      var rightNum = "";

      if (line.startsWith("+")) {
        cls = "ins";
        sign = "+";
        rightNum = headLine;
        headLine += 1;
      } else if (line.startsWith("-")) {
        cls = "del";
        sign = "-";
        leftNum = baseLine;
        baseLine += 1;
      } else {
        leftNum = baseLine;
        rightNum = headLine;
        baseLine += 1;
        headLine += 1;
      }

      html +=
        '<tr class="' +
        cls +
        '">' +
        '<td class="ln">' +
        leftNum +
        "</td>" +
        '<td class="ln">' +
        rightNum +
        "</td>" +
        '<td class="dsign">' +
        esc(sign) +
        "</td>" +
        "<td>" +
        esc(line) +
        "</td>" +
        "</tr>";
    });

    html += "</tbody></table>";
    body.innerHTML = html;

    var table = document.querySelector("#diff-body .dt");
    if (table) table.classList.toggle("wrap", wrapOn);
  }
  function getMessage(files) {
    const total = files.length;

    if (total === 0) return "✨ clean branch!";
    if (total < 3) return "🧩 tiny changes!";
    if (total < 10) return "🔍 reviewing changes!";
    if (total < 30) return "⚡ big diff detected!";
    return "🔥 massive changes!";
  }
  window.addEventListener("message", function (ev) {
    var msg = ev.data;

    if (msg.type === "loading") {
      document.getElementById("m-msg").textContent = "scanning...";
      document.getElementById("m-count").textContent = "...";
      document.getElementById("file-list").innerHTML =
        '<div style="padding:16px 12px;font-size:11px;font-family:var(--mono);opacity:.5;text-align:center"><span class="spin"></span> loading...</div>';
    }

    if (msg.type === "data") {
      state.files = msg.files || [];
      state.error = msg.error || null;
      state.mode = msg.mode || "compareBase";
      state.base = msg.baseBranch || "main";
      state.branch = msg.branch || "...";
      state.localTarget = msg.localTarget || "HEAD";

      document.getElementById("t-branch").textContent = state.branch;
      var modeBtn = document.getElementById("btn-mode");
      if (modeBtn) {
        modeBtn.innerHTML =
          state.mode === "compareBase"
            ? '<span class="ico">&#x21CC;</span><span>BRANCH</span>'
            : '<span class="ico">&#x21CC;</span><span>LOCAL</span>';
      }
      document.getElementById("t-base").textContent = "\u270E " + state.base;
      document.getElementById("t-local-target").textContent =
        "\u270E " + state.localTarget;

      document.getElementById("vs-sep").style.display =
        state.mode === "compareBase" ? "" : "none";
      document.getElementById("t-base").style.display =
        state.mode === "compareBase" ? "" : "none";
      document.getElementById("t-local-target").style.display =
        state.mode === "workingTree" ? "" : "none";

      var n = state.files.length;
      document.getElementById("m-count").textContent =
        n + " file" + (n !== 1 ? "s" : "");
      document.getElementById("m-msg").textContent = state.error
        ? "🚨 error detected!"
        : getMessage(state.files);

      var counts = getCategoryCounts(state.files || []);
      if (state.filter !== "ALL" && !counts[state.filter]) {
        state.filter = "ALL";
      }
      renderPills();
      renderFiles();
    }

    if (msg.type === "diffResult") {
      if (!state.sel || state.sel.filePath !== msg.filePath) return;

      if (msg.diffError) {
        document.getElementById("diff-body").innerHTML =
          '<div class="d-info d-err">Cannot load diff.</div>';
        return;
      }

      renderUnifiedDiff(msg.diffText || "");
    }
  });

  vscode.postMessage({ type: "ready" });
})();
