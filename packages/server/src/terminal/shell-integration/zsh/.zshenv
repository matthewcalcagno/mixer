typeset -g MIXER_SHELL_INTEGRATION_DIR="${${(%):-%N}:A:h}"

if [[ -n "${MIXER_ZSH_ZDOTDIR-}" ]]; then
  export ZDOTDIR="${MIXER_ZSH_ZDOTDIR}"
else
  unset ZDOTDIR
fi

if [[ -n "${ZDOTDIR-}" ]]; then
  if [[ -f "${ZDOTDIR}/.zshenv" ]]; then
    source "${ZDOTDIR}/.zshenv"
  fi
elif [[ -f "${HOME}/.zshenv" ]]; then
  source "${HOME}/.zshenv"
fi

source "${MIXER_SHELL_INTEGRATION_DIR}/mixer-integration.zsh"
