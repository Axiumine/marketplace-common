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
# in the gitignored .yarnrc, or in ~/.yarnrc. Ask yarn which registry it would
# actually use — that is the same value scripts/lockfile-registry-filter.sh reads
# during the install below, so the fetch and the yarn.lock filter cannot end up on
# two different hosts.
#
# Installing through a mirror is the whole point of this script: it wipes
# node_modules first, so with yarn on the public registry it would do nothing but
# refill it from npmjs — slowly, over the internet, which is the one outcome this
# script is not for. Blocked here, ahead of the first destructive line, and after
# the sourcing above so ~/.yarnrc is in play.
REGISTRY="$(yarn --silent config get registry 2> /dev/null || true)"
case "${REGISTRY%/}" in
	'' | undefined | 'https://registry.npmjs.org' | 'https://registry.yarnpkg.com')
		echo "z-ram: BLOCKED — yarn resolves against ${REGISTRY:-<nothing>}, which is not a local mirror." >&2
		echo 'z-ram: point yarn at your mirror first, then re-run:' >&2
		echo "z-ram:     printf 'registry \"http://<your-mirror>/\"\\n' > .yarnrc   # this checkout only" >&2
		echo "z-ram: or  yarn config set registry 'http://<your-mirror>/'          # every project" >&2
		exit 1
		;;
esac

mkdir -p /var/ram/marketplace-common/node_modules
rm -rf node_modules/*
sync
mkdir node_modules
sudo mount --bind /var/ram/marketplace-common/node_modules node_modules  # <--- add to sudoers

#install dependencies. yarn routes them through the registry checked above on its
# own; `prepare` -> `hooks:install` reads that same host out of yarn and records it
# for the yarn.lock filter.
yarn install

# create the control file
touch /var/ram/marketplace-common/started
