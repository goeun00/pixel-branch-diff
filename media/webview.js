(function () {
  var vscode = acquireVsCodeApi();

  var state = {
    files: [],
    filter: "ALL",
    sel: null,
    mode: "compareBase",
    base: "main",
    branch: "...",
    diffOpen: false,
    error: null,
  };

  function getCategoryCounts(files) {
    var counts = {
      ALL: files.length,
    };
    files.forEach(function (f) {
      var cat = f.category || "ETC";
      counts[cat] = (counts[cat] || 0) + 1;
    });
    return counts;
  }

  var wrapOn = false;
  var pillsEl = document.getElementById("pills");
  var PILLS = ["ALL", "MARKUP", "JS", "JSX", "CSS", "IMG", "ETC"];

  function getCategoryCounts(files) {
    var counts = {
      ALL: files.length,
    };

    files.forEach(function (f) {
      var cat = f.category || "ETC";
      counts[cat] = (counts[cat] || 0) + 1;
    });

    return counts;
  }

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

    var filtered = state.files.filter(function (f) {
      return state.filter === "ALL" || f.category === state.filter;
    });

    if (!filtered.length) {
      var d = document.createElement("div");
      d.id = "empty-state";
      d.innerHTML =
        '<div style="font-size:22px;margin-bottom:8px">&#11035;</div>' +
        (state.files.length
          ? "No " + state.filter + " files changed."
          : "No changes on this branch.");
      list.appendChild(d);
      return;
    }

    filtered.forEach(function (f) {
      var item = document.createElement("div");
      var isSel = state.sel && state.sel.filePath === f.filePath;
      item.className = "fi" + (isSel ? " sel" : "");

      var basename = f.filePath.split("/").pop();
      var dir = f.filePath.split("/").slice(0, -1).join("/");
      var renameText = "";

      if (f.status === "R" && f.oldPath) {
        renameText = f.oldPath + " → " + f.filePath;
      }

      item.innerHTML =
        '<div class="fi-top">' +
        '<span class="sbadge s-' +
        esc(f.status) +
        '">' +
        esc(f.status) +
        "</span>" +
        '<span class="fname" title="' +
        esc(f.filePath) +
        '">' +
        esc(basename) +
        "</span>" +
        '<span class="cat">' +
        esc(f.category) +
        "</span>" +
        "</div>" +
        (renameText
          ? '<div class="fdir fdir--rename">' + esc(renameText) + "</div>"
          : dir
            ? '<div class="fdir">' + esc(dir) + "</div>"
            : "") +
        '<div class="fi-actions">' +
        '<button class="btn ghost sm" data-a="diff"><span class="ico">&#8800;</span><span>Diff</span></button>' +
        '<button class="btn ghost sm" data-a="editorDiff"><span class="ico">&#x2197;</span><span>Editor</span></button>' +
        "</div>";

      item.addEventListener("click", function (ev) {
        if (ev.target.closest("[data-a]")) return;
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
  }

  function loadDiff(f) {
    state.sel = f;
    state.diffOpen = true;
    document.getElementById("main").classList.add("diff-open");

    if (f.status === "R" && f.oldPath) {
      document.getElementById("diff-fname").textContent =
        f.oldPath + " → " + f.filePath;
    } else {
      document.getElementById("diff-fname").textContent = f.filePath;
    }

    document.getElementById("diff-body").innerHTML =
      '<div class="d-info"><span class="spin"></span> loading...</div>';

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
    var fileName = filePath ? filePath.split("/").pop() : "";
    var dir = filePath ? filePath.split("/").slice(0, -1).join("/") : "";
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
              ? "RENAMED + MODIFIED"
              : "RENAMED"
            : "MODIFIED";

    var headerHtml =
      '<div class="diff-meta">' +
      '<div class="diff-meta__file">' +
      esc(fileName) +
      "</div>" +
      '<div class="diff-meta__dir">' +
      esc(dir) +
      "</div>" +
      '<div class="diff-meta__stat">' +
      '<span class="diff-meta__status">' +
      statusText +
      "</span>" +
      '<span class="diff-meta__count diff-meta__count--add">+' +
      addCount +
      "</span>" +
      '<span class="diff-meta__count diff-meta__count--del">-' +
      delCount +
      "</span>" +
      "</div>" +
      "</div>";

    if (status === "R" && !hasVisibleDiff) {
      body.innerHTML =
        headerHtml +
        '<div class="d-info">📦 File renamed without changes.</div>';
      return;
    }

    if (!diffText) {
      body.innerHTML =
        headerHtml +
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
      ) {
        return;
      }

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
    body.innerHTML = headerHtml + html;

    var table = document.querySelector("#diff-body .dt");
    if (table) {
      table.classList.toggle("wrap", wrapOn);
    }
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
      document.getElementById("t-branch").textContent = state.branch;
      var modeBtn = document.getElementById("btn-mode");
      if (modeBtn) {
        modeBtn.innerHTML =
          state.mode === "compareBase"
            ? '<span class="ico">&#x21CC;</span><span>BRANCH</span>'
            : '<span class="ico">&#x21CC;</span><span>LOCAL</span>';
      }
      document.getElementById("t-base").textContent = state.base;
      document.getElementById("vs-sep").style.display =
        state.mode === "compareBase" ? "" : "none";
      document.getElementById("t-base").style.display =
        state.mode === "compareBase" ? "" : "none";

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
