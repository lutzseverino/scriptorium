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
    case "$(dpkg --print-architecture)" in \
      amd64) git_arch=x64; gh_arch=amd64; codex_arch=x86_64; claude_arch=x64 ;; \
      arm64) git_arch=arm64; gh_arch=arm64; codex_arch=aarch64; claude_arch=arm64 ;; \
      *) echo 'The factory agent layer supports amd64 and arm64' >&2; exit 1 ;; \
    esac; \
    mkdir -p /opt/factory/git /tmp/factory-tools; \
    curl -fsSL "https://github.com/desktop/dugite-native/releases/download/v2.53.0-4/dugite-native-v2.53.0-4098283-ubuntu-${git_arch}.tar.gz" \
      -o /tmp/factory-tools/git.tar.gz; \
    tar -xzf /tmp/factory-tools/git.tar.gz -C /opt/factory/git; \
    curl -fsSL "https://github.com/cli/cli/releases/download/v2.102.0/gh_2.102.0_linux_${gh_arch}.tar.gz" \
      -o /tmp/factory-tools/gh.tar.gz; \
    tar -xzf /tmp/factory-tools/gh.tar.gz -C /tmp/factory-tools; \
    install -m 0755 "/tmp/factory-tools/gh_2.102.0_linux_${gh_arch}/bin/gh" /usr/local/bin/gh; \
    curl -fsSL "https://github.com/openai/codex/releases/download/rust-v0.162.1/codex-${codex_arch}-unknown-linux-musl.tar.gz" \
      -o /tmp/factory-tools/codex.tar.gz; \
    tar -xzf /tmp/factory-tools/codex.tar.gz -C /tmp/factory-tools; \
    install -m 0755 "/tmp/factory-tools/codex-${codex_arch}-unknown-linux-musl" /usr/local/bin/codex; \
    curl -fsSL "https://github.com/openai/codex/releases/download/rust-v0.162.1/codex-code-mode-host-${codex_arch}-unknown-linux-musl.tar.gz" \
      -o /tmp/factory-tools/codex-code-mode-host.tar.gz; \
    tar -xzf /tmp/factory-tools/codex-code-mode-host.tar.gz -C /tmp/factory-tools; \
    install -m 0755 "/tmp/factory-tools/codex-code-mode-host-${codex_arch}-unknown-linux-musl" \
      /usr/local/bin/codex-code-mode-host; \
    curl -fsSL "https://downloads.claude.ai/claude-code-releases/2.1.287/linux-${claude_arch}/claude" \
      -o /usr/local/bin/claude; \
    chmod 0755 /usr/local/bin/claude; \
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
