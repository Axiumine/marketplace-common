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

mkdir -p /var/ram/marketplace-common/node_modules
rm -rf node_modules/*
sync
mkdir node_modules
sudo mount --bind /var/ram/marketplace-common/node_modules node_modules  # <--- add to sudoers

# use the local repository cache so packages are not downloaded from the internet
# this file must not be present when the app is sent to eas build
cp yarnrc .yarnrc

# remove yarn.lock, which may reference the online server instead of the local one
rm yarn.lock

#install dependencies
yarn install

# create the control file
touch /var/ram/marketplace-common/started
