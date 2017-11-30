
SensEdge
========

This repo is for ElderSens Inc's SensEdge Project.

###Build on MacOS

0. Make sure Xcode is installed
https://developer.apple.com/xcode/downloads/

1. Install Homebrew if it's not already installed
`ruby -e "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/master/install)"`

2. Install Node.js and npm
`brew install node`

3. Install MQTT client mosquitto
`brew install mosquitto`

4. Install Node.js modules: noble, nodemailer, ip, etc.
`./run.sh install`

###Build on Raspberry Pi
`./run.sh install`

###FallSens Calibration
`./run.sh calibration [<MAC address>]`
If no MAC address is provided, the first found FallSens device will be used for calibration.
When it's finished, append the generated line to calibrationTable in sensedge.js. For example:

`'e6:d7:22:59:ed:ed' : [ -0.0018,  0.0122,  0.0566,  24.5 ],`

###Run
`./run.sh`
