if [[ -n "${_MIXER_ZSH_INTEGRATION_LOADED-}" ]]; then
  return
fi
typeset -g _MIXER_ZSH_INTEGRATION_LOADED=1

autoload -Uz add-zsh-hook

typeset -g _MIXER_ZSH_COMMAND_ACTIVE=0

function _mixer_osc633() {
  printf '\e]633;%s\a' "$1"
}

function _mixer_precmd() {
  local command_status=$?
  if [[ "$_MIXER_ZSH_COMMAND_ACTIVE" == "1" ]]; then
    _mixer_osc633 "D;${command_status}"
    _MIXER_ZSH_COMMAND_ACTIVE=0
  fi
  printf '\e]2;%s\a' "${PWD/#$HOME/~}"
  _mixer_osc633 "A"
}

function _mixer_preexec() {
  _MIXER_ZSH_COMMAND_ACTIVE=1
  _mixer_osc633 "B"
  _mixer_osc633 "C"
  printf '\e]2;%s\a' "$1"
}

add-zsh-hook precmd _mixer_precmd
add-zsh-hook preexec _mixer_preexec
