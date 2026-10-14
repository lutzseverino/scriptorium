ARG TOOLCHAIN_IMAGE
FROM ${TOOLCHAIN_IMAGE}

USER root
ARG AGENT_UID
ARG AGENT_GID

# Every edit to this layer requires an AGENT_LAYER_VERSION bump.
# Release binaries keep the repository's toolchain independent of Node.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl tar gzip passwd libatomic1 \
    && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
    git_release=v2.53.0-4; git_build=v2.53.0-4098283; \
    git_sha256_amd64=cca76aa31ad9e835e771ee7f55b73934777fbd8d16757a10d307ba06de860901; \
    git_sha256_arm64=a161f45af4626bb7e0c688854bd4a9aee47cc514bca404cff0a5e3536ef1c0af; \
    gh_version=2.102.0; \
    gh_sha256_amd64=bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386; \
    gh_sha256_arm64=7862c86c72f43df3a2d93ddde6f473285b4e2af61b494849846827e513ef6484; \
    codex_version=0.162.1; \
    codex_sha256_amd64=86f268d81b898f3e144c5ecff2ad2fda2c5802e042d6195b72538fe0fa125057; \
    codex_sha256_arm64=bf3ca2719f1143b1440fbd85c149379e696c782c50ad7991f8bfcec60b2600c1; \
    code_mode_host_sha256_amd64=458239ea45c1fc508d89695f180ab352f2834709a8a46929a4466f4f04399ada; \
    code_mode_host_sha256_arm64=1395ce9367f8acd280674dff083edf25bf221d908b8351d5bd4f3fdde9181e9a; \
    claude_version=2.1.287; \
    claude_sha256_amd64=3920489a5109cff5786a1a392c25277408ff22bc796d5edb9c16a60e5a1718f0; \
    claude_sha256_arm64=e4daf793d1e74fb0d9874dd09e98690bbfd7be515f78a87fd05b9e2b4bb33b03; \
    case "$(dpkg --print-architecture)" in \
      amd64) git_arch=x64; gh_arch=amd64; codex_arch=x86_64; claude_arch=x64; \
        git_sha256=$git_sha256_amd64; gh_sha256=$gh_sha256_amd64; \
        codex_sha256=$codex_sha256_amd64; code_mode_host_sha256=$code_mode_host_sha256_amd64; \
        claude_sha256=$claude_sha256_amd64 ;; \
      arm64) git_arch=arm64; gh_arch=arm64; codex_arch=aarch64; claude_arch=arm64; \
        git_sha256=$git_sha256_arm64; gh_sha256=$gh_sha256_arm64; \
        codex_sha256=$codex_sha256_arm64; code_mode_host_sha256=$code_mode_host_sha256_arm64; \
        claude_sha256=$claude_sha256_arm64 ;; \
      *) echo 'The factory agent layer supports amd64 and arm64' >&2; exit 1 ;; \
    esac; \
    verified_download() { \
      curl -fsSL "$1" -o "$3"; \
      printf '%s  %s\n' "$2" "$3" | sha256sum -c -; \
    }; \
    mkdir -p /opt/factory/git /tmp/factory-tools; \
    verified_download "https://github.com/desktop/dugite-native/releases/download/${git_release}/dugite-native-${git_build}-ubuntu-${git_arch}.tar.gz" \
      "$git_sha256" /tmp/factory-tools/git.tar.gz; \
    tar -xzf /tmp/factory-tools/git.tar.gz -C /opt/factory/git; \
    verified_download "https://github.com/cli/cli/releases/download/v${gh_version}/gh_${gh_version}_linux_${gh_arch}.tar.gz" \
      "$gh_sha256" /tmp/factory-tools/gh.tar.gz; \
    tar -xzf /tmp/factory-tools/gh.tar.gz -C /tmp/factory-tools; \
    install -m 0755 "/tmp/factory-tools/gh_${gh_version}_linux_${gh_arch}/bin/gh" /usr/local/bin/gh; \
    verified_download "https://github.com/openai/codex/releases/download/rust-v${codex_version}/codex-${codex_arch}-unknown-linux-musl.tar.gz" \
      "$codex_sha256" /tmp/factory-tools/codex.tar.gz; \
    tar -xzf /tmp/factory-tools/codex.tar.gz -C /tmp/factory-tools; \
    install -m 0755 "/tmp/factory-tools/codex-${codex_arch}-unknown-linux-musl" /usr/local/bin/codex; \
    verified_download "https://github.com/openai/codex/releases/download/rust-v${codex_version}/codex-code-mode-host-${codex_arch}-unknown-linux-musl.tar.gz" \
      "$code_mode_host_sha256" /tmp/factory-tools/codex-code-mode-host.tar.gz; \
    tar -xzf /tmp/factory-tools/codex-code-mode-host.tar.gz -C /tmp/factory-tools; \
    install -m 0755 "/tmp/factory-tools/codex-code-mode-host-${codex_arch}-unknown-linux-musl" \
      /usr/local/bin/codex-code-mode-host; \
    verified_download "https://downloads.claude.ai/claude-code-releases/${claude_version}/linux-${claude_arch}/claude" \
      "$claude_sha256" /tmp/factory-tools/claude; \
    install -m 0755 /tmp/factory-tools/claude /usr/local/bin/claude; \
    rm -rf /tmp/factory-tools

# A run's provider login must add no GitHub identity beside the minted token,
# so the provider policy, system policy that outranks the agent's own
# configuration and flags, turns off the account's apps and connectors. The
# layer owns these paths and replaces whatever the toolchain image put there.
RUN set -eu; \
    rm -rf /etc/codex /etc/claude-code; \
    install -d -m 0755 /etc/codex /etc/claude-code; \
    printf '%s\n' '[features]' 'apps = false' 'enable_mcp_apps = false' \
      'codex_apps_mcp_2026_07_28 = false' > /etc/codex/requirements.toml; \
    printf '%s\n' '{ "disableClaudeAiConnectors": true }' \
      > /etc/claude-code/managed-settings.json; \
    chmod 0644 /etc/codex/requirements.toml /etc/claude-code/managed-settings.json

RUN set -eu; \
    uid_owner=$(getent passwd "$AGENT_UID" | cut -d: -f1); \
    if [ -n "$uid_owner" ] && [ "$uid_owner" != agent ]; then \
      userdel "$uid_owner"; \
    fi; \
    group_name=$(getent group "$AGENT_GID" | cut -d: -f1); \
    if [ -z "$group_name" ]; then \
      group_name=agent; \
      if getent group agent >/dev/null; then \
        groupmod -g "$AGENT_GID" agent; \
      else \
        groupadd -g "$AGENT_GID" agent; \
      fi; \
    fi; \
    if id agent >/dev/null 2>&1; then \
      usermod -u "$AGENT_UID" -g "$group_name" -d /home/agent -s /bin/bash agent; \
    else \
      useradd -u "$AGENT_UID" -g "$group_name" -d /home/agent -m -s /bin/bash agent; \
    fi; \
    mkdir -p /home/agent; \
    chown -R "$AGENT_UID:$AGENT_GID" /home/agent

LABEL factory.agent.identity="${AGENT_UID}:${AGENT_GID}"
ENV HOME=/home/agent \
    PATH="/opt/factory/git/bin:/usr/local/bin:${PATH}" \
    GIT_EXEC_PATH=/opt/factory/git/libexec/git-core \
    DISABLE_AUTOUPDATER=1
USER agent
WORKDIR /home/agent
ENTRYPOINT ["sleep", "infinity"]
