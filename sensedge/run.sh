#!/bin/sh

if [ "$1" = "install" ]; then
	if [ -f /etc/os-release ]; then
		grep 'ID=raspbian' /etc/os-release > /dev/null
		if [ $? -eq 0 ]; then
			version=$(grep VERSION_ID /etc/os-release |sed 's/VERSION_ID="\(.*\)"/\1/')
			if [ ${version} -lt 9 ]; then
				# update node to v7.x
				curl -sL https://deb.nodesource.com/setup_7.x | sudo -E bash -
				# install mosquitto
				wget http://repo.mosquitto.org/debian/mosquitto-repo.gpg.key
				sudo apt-key add mosquitto-repo.gpg.key
				rm mosquitto-repo.gpg.key
				sudo wget http://repo.mosquitto.org/debian/mosquitto-jessie.list
				sudo mv mosquitto-jessie.list /etc/apt/sources.list.d/
			else
				# update node to v8.x
				curl -sL https://deb.nodesource.com/setup_8.x | sudo -E bash -
			fi
			sudo apt-get update
			sudo apt -y install nodejs
			sudo apt -y install mosquitto mosquitto-clients
			npm install
			# patch noble with bluez hci workaround
			rm -rf node_modules/bluetooth-hci-socket
			npm install sandeepmistry/node-bluetooth-hci-socket#rework-kernel-workarounds
			# access BT without root
			sudo setcap cap_net_raw+eip $(eval readlink -f `which node`)
			sudo setcap cap_net_raw,cap_net_admin+eip $(eval readlink -f `which hciconfig`)
			# install sensedge init.d script
			sudo cp scripts/sensedge /etc/init.d/
			sudo systemctl enable sensedge
		fi
	else
		npm install
	fi
	exit 0
fi
if [ "$1" = "sim" ]; then
	node -e 'require("./sensedge").simulate()'
else
	if [ $(uname -s) = "Linux" ]; then
		sudo hciconfig hci0 reset
	fi
	if [ "$1" = "calibrate" ]; then
		node ./sensedge.js calibrate $2
	else
		node ./sensedge.js
	fi
fi
