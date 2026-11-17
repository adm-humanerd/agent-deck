# Source explicitly from an interactive, pane-root zsh, or use the receiver CLI.
# Local hooks/options are a trusted cooperation protocol, not a sandbox against
# the shell user or other clients with permission to this explicit tmux socket.
[[ -o interactive && -n ${TMUX-} && ${TMUX_PANE-} == %<-> ]] || return 1
(( ${+_agent_deck_shell_epoch} )) && return 0

typeset -g _agent_deck_tmux=${AGENT_DECK_TMUX:-tmux}
typeset -g _agent_deck_socket=${TMUX%,*}
_agent_deck_socket=${_agent_deck_socket%,*}
[[ ( $_agent_deck_tmux == tmux || ( $_agent_deck_tmux == /* && -x $_agent_deck_tmux ) ) && $_agent_deck_socket == /* ]] || return 1
[[ $("$_agent_deck_tmux" -S "$_agent_deck_socket" -N display-message -p -t "$TMUX_PANE" '#{pane_pid}') == $$ ]] || return 1

typeset -gr _agent_deck_shell_epoch=$(/usr/bin/uuidgen)
[[ $_agent_deck_shell_epoch =~ '^[[:xdigit:]-]{36}$' ]] || return 1

# This mapping qualifies only this managed ZLE keymap, not arbitrary terminal
# applications. Bracketed paste makes tab/multiline payloads literal ZLE data.
bindkey -e
bindkey -M emacs '^U' kill-whole-line
bindkey -M emacs '^M' accept-line
bindkey -M emacs '\e[200~' bracketed-paste
bindkey -M emacs '\e[991~' agent-deck-ack

_agent_deck_preexec() {
  # Foreground/synchronous client: do not start a command with a stale idle bit.
  "$_agent_deck_tmux" -S "$_agent_deck_socket" -N set-option -p -t "$TMUX_PANE" @agent_deck_idle 0
}
_agent_deck_precmd() {
  local nonce=$(/usr/bin/uuidgen)
  [[ $nonce =~ '^[[:xdigit:]-]{36}$' ]] || return 1
  [[ $("$_agent_deck_tmux" -S "$_agent_deck_socket" -N display-message -p -t "$TMUX_PANE" '#{pane_pid}') == $$ ]] || return 1
  "$_agent_deck_tmux" -S "$_agent_deck_socket" -N \
    set-option -p -t "$TMUX_PANE" @agent_deck_idle 0 \; \
    set-option -p -t "$TMUX_PANE" @agent_deck_pid "$$" \; \
    set-option -p -t "$TMUX_PANE" @agent_deck_shell "$_agent_deck_shell_epoch" \; \
    set-option -p -t "$TMUX_PANE" @agent_deck_mapping tmux-zsh-idle-v1 \; \
    set-option -p -t "$TMUX_PANE" @agent_deck_idle "$nonce"
}
autoload -Uz add-zsh-hook
add-zsh-hook preexec _agent_deck_preexec
add-zsh-hook precmd _agent_deck_precmd
_agent_deck_ack() {
  # ZLE invokes this only after earlier queued bytes/widgets finish. We are
  # editing a shell line, not inferring readiness from a process or timer.
  _agent_deck_precmd
}
zle -N agent-deck-ack _agent_deck_ack
_agent_deck_preexec
