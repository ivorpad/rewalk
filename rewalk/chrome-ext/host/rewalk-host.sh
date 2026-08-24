#!/bin/sh
# Chrome execs this; it must be absolute and executable. install.sh fills the
# path into the host manifest and points it here.
exec "$(command -v node)" "$(dirname "$0")/rewalk-host.mjs"
