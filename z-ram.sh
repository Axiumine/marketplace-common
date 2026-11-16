#!/bin/bash

# first run installs, later runs start expo
if [ -f /var/ram/marketplace-common/started ];
then
  exit
fi
# else, install & start

#load nvm
. ~/.nvm/nvm.sh
. ~/.profile
. ~/.bashrc

# set node
nvm use v24.18.0  # if this changes, update the other .sh scripts too
node --version

# The mirror is opt-in and nothing tracked in this repo names one; the host lives
# as `npmRegistryServer` in ~/.yarnrc.yml (the project's committed file sets none,
# so that it cannot override a mirror). Ask yarn which registry it would actually
# use, so the fetch below goes where this check looked.
#
# Installing through a mirror is the whole point of this script: it wipes
# node_modules first, so with yarn on the public registry it would do nothing but
# refill it from npmjs — slowly, over the internet, which is the one outcome this
# script is not for. Blocked here, ahead of the first destructive line, and after
# the sourcing above so the home configuration is in play.
REGISTRY="$(yarn config get npmRegistryServer 2> /dev/null || true)"
case "${REGISTRY%/}" in
	'' | undefined | 'https://registry.npmjs.org' | 'https://registry.yarnpkg.com')
		echo "z-ram: BLOCKED — yarn resolves against ${REGISTRY:-<nothing>}, which is not a local mirror." >&2
		echo 'z-ram: point yarn at your mirror first, then re-run:' >&2
		echo "z-ram:     yarn config set npmRegistryServer 'http://<your-mirror>/' --home   # every project" >&2
		echo 'z-ram: an http:// mirror also needs its host in unsafeHttpWhitelist (same --home file)' >&2
		exit 1
		;;
esac

mkdir -p /var/ram/marketplace-common/node_modules
rm -rf node_modules/*
sync
mkdir node_modules
sudo mount --bind /var/ram/marketplace-common/node_modules node_modules  # <--- add to sudoers

#install dependencies. yarn routes them through the registry checked above on its
# own. A Yarn 4 lockfile carries no registry URL, so nothing needs filtering.
yarn install

# create the control file
touch /var/ram/marketplace-common/started
