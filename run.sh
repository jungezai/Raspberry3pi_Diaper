#!/bin/sh

if [ "$1" = "install" ]; then
	if [ -f /etc/os-release ]; then
		grep 'ID=raspbian' /etc/os-release > /dev/null
		if [ $? -eq 0 ]; then
			# update node to v7.x
			curl -sL https://deb.nodesource.com/setup_7.x | sudo -E bash -
			sudo apt install nodejs
			# install mosquitto
			wget http://repo.mosquitto.org/debian/mosquitto-repo.gpg.key
			sudo apt-key add mosquitto-repo.gpg.key
			rm mosquitto-repo.gpg.key
			sudo wget http://repo.mosquitto.org/debian/mosquitto-jessie.list
			sudo mv mosquitto-jessie.list /etc/apt/sources.list.d/
			sudo apt-get update
			sudo apt install mosquitto
			sudo apt install mosquitto-clients
			# patch noble with bluez hci workaround
			rm -rf node_modules/bluetooth-hci-socket
			npm install sandeepmistry/node-bluetooth-hci-socket#rework-kernel-workarounds
			# access BT without root
			sudo setcap cap_net_raw+eip $(eval readlink -f `which node`)
			# copy config file
			mkdir -p ~/ElderSens
			cp scripts/DiaperSens.config ~/ElderSens/
			# install diapersense init.d script
			sudo cp scripts/diapersens /etc/init.d/
			sudo systemctl enable diapersens
			sudo systemctl start diapersens
		fi
	fi
	npm install noble nodemailer ip
	exit 0
fi
if [ "$1" = "sim" ]; then
	node -e 'require("./diapersens").simulate()'
else
	if [ $(uname -s) = "Linux" ]; then
		sudo hciconfig hci0 reset
	fi
	node ./diapersens.js
fi
