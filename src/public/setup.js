const statusList = document.getElementById("status-list");
const envList = document.getElementById("env-list");
const configPaths = document.getElementById("config-paths");
const logsEl = document.getElementById("logs");
const configEditor = document.getElementById("user-config");
const configMessage = document.getElementById("config-message");

const openDashboardButton = document.getElementById("open-dashboard");
const openWizardButton = document.getElementById("open-wizard");
const restartButton = document.getElementById("restart-daemon");
const saveConfigButton = document.getElementById("save-config");
const reloadConfigButton = document.getElementById("reload-config");

function badge(status, label) {
  return `<span class="badge ${status}">${label}</span>`;
}

function formatState(value) {
  if (value === true) return badge("success", "Ready");
  if (value === false) return badge("warn", "Pending");
  return badge("danger", "Error");
}

function renderStatus(status) {
  const daemon = status.daemon;
  const rows = [
    {
      title: "Setup Wrapper",
      detail: "Password-protected setup page and Railway healthcheck endpoint.",
      state: status.ok,
    },
    {
      title: "OpenFang Daemon",
      detail: daemon.running
        ? daemon.healthy
          ? `Healthy on localhost:4200${daemon.pid ? `, pid ${daemon.pid}` : ""}`
          : "Process is running but healthcheck is still warming up."
        : daemon.lastError || "Process is not running.",
      state: daemon.running && daemon.healthy,
    },
    {
      title: "Persistent Config",
      detail: "Generated base config plus user overlay inside the Railway volume.",
      state: true,
    },
  ];

  statusList.innerHTML = rows
    .map(
      (row) => `
        <div class="status-row">
          <div class="status-meta">
            <strong>${row.title}</strong>
            <span class="subtle">${row.detail}</span>
          </div>
          ${formatState(row.state)}
        </div>
      `
    )
    .join("");

  configPaths.textContent = [
    `OPENFANG_HOME: ${status.configPaths.openfangHome}`,
    `config.toml: ${status.configPaths.config}`,
    `config.user.toml: ${status.configPaths.userConfig}`,
    `secrets.env: ${status.configPaths.secrets}`,
    `Restart count: ${daemon.restartCount}`,
  ].join("\n");

  envList.innerHTML = status.env
    .map((item) => {
      const state = item.configured ? badge("success", "Configured") : item.required ? badge("danger", "Missing") : badge("warn", "Optional");
      return `
        <div class="env-row">
          <div>
            <strong>${item.name}</strong>
            <span class="subtle">${item.required ? "Required for a clean deploy." : "Optional, but useful for a ready-to-run template."}</span>
          </div>
          ${state}
        </div>
      `;
    })
    .join("");

  logsEl.textContent = (status.logs || []).join("\n") || "(no logs yet)";
  openDashboardButton.disabled = !daemon.healthy;
  openWizardButton.disabled = !daemon.healthy;
}

async function loadStatus() {
  const response = await fetch("/setup/api/status", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error("Could not load setup status.");
  }

  const status = await response.json();
  renderStatus(status);
}

async function loadConfig() {
  const response = await fetch("/setup/api/config", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error("Could not load config.user.toml.");
  }

  const payload = await response.json();
  configEditor.value = payload.content || "";
}

async function saveConfig() {
  configMessage.textContent = "Saving config overlay and restarting OpenFang...";
  saveConfigButton.disabled = true;

  try {
    const response = await fetch("/setup/api/config", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: configEditor.value }),
    });

    if (!response.ok) {
      throw new Error("Could not save config.user.toml.");
    }

    configMessage.textContent = "Saved. The daemon is restarting with your overlay.";
  } catch (error) {
    configMessage.textContent = error.message;
  } finally {
    saveConfigButton.disabled = false;
    setTimeout(() => {
      loadStatus().catch(() => {});
    }, 1000);
  }
}

async function restartDaemon() {
  restartButton.disabled = true;
  try {
    const response = await fetch("/setup/api/restart", { method: "POST" });
    if (!response.ok) {
      throw new Error("Restart request failed.");
    }
  } catch (error) {
    configMessage.textContent = error.message;
  } finally {
    restartButton.disabled = false;
  }
}

openDashboardButton.addEventListener("click", () => {
  window.location.href = "/setup/open-dashboard?target=%2F";
});

openWizardButton.addEventListener("click", () => {
  window.location.href = "/setup/open-dashboard?target=%2F%23wizard";
});

restartButton.addEventListener("click", () => {
  restartDaemon().catch(() => {});
});

saveConfigButton.addEventListener("click", () => {
  saveConfig().catch(() => {});
});

reloadConfigButton.addEventListener("click", () => {
  loadConfig().catch((error) => {
    configMessage.textContent = error.message;
  });
});

await Promise.all([loadStatus(), loadConfig()]);
setInterval(() => {
  loadStatus().catch(() => {});
}, 4000);
