var os = require('os');
var noble = require('noble');
var nodemailer = require('nodemailer');
var ip = require('ip');
var mqsh = require('/home/pi/ElderSens/mqpubsub.js');

var RH_THRESHOLD = 80

const u1_carrier = 'AT&T';
const u1_number = '1234567';
const u2_carrier = 'Verizon';
const u2_number = '1234567';
const u3_carrier = 'T-Mobile';
const u3_number = '1234567';

var Is_Connecting = false;
/*
const phoneBook = {
	'Li':		{ 'carrier': 'Verizon',  'number': '2082720078' },
};
*/
const phoneBook = {
	'Huang':		{ 'carrier': 'ChinaMobile',  'number': '15819471201' },
};





var monitorTable = {};

// Read ElderSens config file
const fs = require('fs');
const configDir = '/home/pi/ElderSens/';
try {
	var configs = fs.readdirSync(configDir);
	for (var i = 0; i < configs.length; i++) {
		if (configs[i] == 'DiaperSens.config') {
			console.log('xxxxxxxxxxxxxx');
			monitorTable['Sim'] = [];
			var data = fs.readFileSync(configDir + configs[i], 'utf8');
			var lines = data.split(/\r?\n/);
			for (var j = 0; j < lines.length; j++) {
				var line = lines[j].trim();
				if (line.charAt(0) == '#')
					continue;
				if (line.substr(0, 13).toUpperCase() == 'RH THRESHOLD:') {
					RH_THRESHOLD = parseFloat(line.substr(13).trim());
				} else if (line.substr(0, 6).toUpperCase() == 'PHONE:') {
					var phone = line.substr(6).trim().split(' ');
					var carrier = phone[0].trim();
					var number = phone[1].trim();
					monitorTable['Sim'].push({ 'carrier': carrier, 'number': number });
					
						console.log('carrier:'+carrier);
						console.log('number:'+number);

					//var audio = new Audio("/home/pi/ElderSens/cc.mp3");
					//audio.play();
				}
			}
		}
	}
} catch (e) {
	console.log('readdirSync: ' + e);
}
/*
// Detection Algorithm
const ALGO_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
const ALGO_TEMPRAMP_MS = 2 * 60 * 1000; // 2 minutes
const ALGO_TEMPRAMP_VALUE = 0.5; // 0.5 Celsius
const ALGO_TEMPRAMP_TIMEOUT = 4 * 60 * 60 * 1000; // 4 hours
*/
// Detection Algorithm
const ALGO_COOLDOWN_MS = 1 * 60 * 1000; // 1 minute
const ALGO_TEMPRAMP_MS = 0.5 * 60 * 1000; // 0.5 minutes
const ALGO_TEMPRAMP_VALUE = 0.5; // 0.5 Celsius
const ALGO_TEMPRAMP_TIMEOUT = 2 * 60 * 1000; // 2 minute



var gConfig = { 'bootNotification':
			{ 'enable': false, 'os': 'linux', 'uptime': 60, 'recipient': phoneBook['Huang'] },
		'cloudUpdate': true,
};
var gDevices = {};

function Device(peripheral) {
	this.peripheral		= peripheral;
	this.temperature	= 0;
	this.humidity		= 0;
	this.rssi		= peripheral.rssi;
	this.enabled		= false;
	this.notified		= false;
	this.connecting		= false;
	this.symbol		= 'U';
	// detection algorithm related
	this.state		= 'STATE_INIT';
	this.rh_start		= 0;
	this.records		= [];
	this.everbelow		= false;
}









function sensorNotification(type, addr, data) {
	// Send boot notification on Raspberry Pi
	var bn = gConfig['bootNotification'];
	if (bn['enable'] && os.platform() == bn['os'] && os.uptime() < bn['uptime']) {
		// Notify only once
		bn['enable'] = false;
		SendSMS(bn['recipient'], 'host ' + os.hostname() + ' booted',
			'Date: ' + new Date() + '\nUptime: ' + os.uptime() +
			's\nIP: ' + ip.address() + '\nSensor: ' + addr,
			function(error) {
				if (error) {
					console.log('\tSend Boot SMS failed: ' + error);
				} else {
					console.log('\tSend Boot SMS successfully');
				}
		});
	}
	if (type == 'CFX') {
		// data format: flag (1) temperature (4, IEEE 11073 float LE) timestamp (7) type (1)
		//console.log('buf ' + data.toString('hex'));
		var vtype = data.readUInt8(0) & 0x1;
		var man = data.readIntLE(1, 3);
		var exp = data.readInt8(4);
		var value = (man * Math.pow(10, exp)).toFixed(2);
		if (vtype == 0)
			gDevices[addr]['temperature'] = value;
		else
			gDevices[addr]['humidity'] = value;
	} else {
		var len = data.readUInt8(0);
		var flag = data.readUInt8(1);
		var checksum = data.readUInt8(len);
		var cs = 0;
		for (var i = 0; i < len; i++) {
			cs ^= data.readUInt8(i);
		}
		if (cs != checksum) {
			console.log('\tInvalid checksum ' + cs + ' for frame ' + data.toString('hex'));
			return;
		}
		switch (flag) {
		case 1:
			var temperature = (data.readInt16BE(2) / 10.0).toFixed(1);
			var humidity = (data.readInt16BE(4) / 10.0).toFixed(1);
			gDevices[addr]['temperature'] = temperature;
			gDevices[addr]['humidity'] = humidity;
			break;
		case 2:
			var unused_value = data.readInt8(2);
			return;
		}
	}
	if (gConfig['cloudUpdate']) {
		pushAWS(addr, gDevices[addr]['temperature'], gDevices[addr]['humidity'], function(shadow, error) {
		var str = 'cloudUpdate ';
		if (error)
			str += 'failed';
		else
			str += 'success';
		console.log('\t' + gDevices[addr]['symbol'], addr + ' RSSI:' + gDevices[addr]['rssi'], 'temperature',
			    gDevices[addr]['temperature'], 'C humidity', gDevices[addr]['humidity'], '%', str);
		});
	} else {
		console.log('\t' + gDevices[addr]['symbol'], addr + ' RSSI:' + gDevices[addr]['rssi'], 'temperature',
			    gDevices[addr]['temperature'], 'C humidity', gDevices[addr]['humidity'], '%');
	}

	console.log('ddddddddddddddddddddddddddddddddddddddddddddddd\n');
	algo_detection(gDevices[addr]);
}

function algo_detection(dev) {
	
	var now = new Date();


	/*
	if (dev['state'] == 'STATE_INIT') {
		if (dev['humidity'] >= RH_THRESHOLD) {
			dev['rh_start'] = now;
			dev['state'] = 'STATE_HUMIDITY_DETECTED';
		}
		console.log('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n');
	} else if (dev['state'] == 'STATE_HUMIDITY_DETECTED') {
		if (now.getTime() > new Date(dev['rh_start'].getTime() + ALGO_COOLDOWN_MS).getTime()) {
			dev['records'] = [];
			dev['state'] = 'STATE_TEMP_DETECTING';
		}
		console.log('BBBBBBBBBBBBBBBBBBBBBBBBBBBBBB\n');
	} else if (dev['state'] == 'STATE_TEMP_DETECTING') {
	console.log('CCCCCCCCCCCCCCCCCCCCCCCCCCCCC\n');
		for (var i in dev['records']) {
			// keep only 1 minutes records
			if (now.getTime() > new Date(dev['records'][i]['timestamp'].getTime() + ALGO_TEMPRAMP_MS).getTime())
				dev['records'].splice(i, 1);
			else
				break;
		}
		console.log('PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP\n');
		var min = Math.min.apply(Math, dev['records'].map(function(r) {
				return r.temperature;
		}));
		console.log('SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS\n');
		if (dev['temperature'] <= min + ALGO_TEMPRAMP_VALUE) {
			dev['records'].push({'timestamp': now,
					     'temperature': dev['temperature'],
					     'humidity': dev['humidity']});
			console.log('HHHHHHHHHHHHHHHHHHHHHHHHHHHHHH\n');
			return;
		}
		console.log('QQQQQQQQQQQQQQQQQQQQQQQQQQQQ\n');
		
		if (now.getTime() < new Date(dev['rh_start'].getTime() + ALGO_TEMPRAMP_TIMEOUT).getTime()) {
			return;
		}
		
console.log('DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD\n');
		// Otherwise we claim it's detected!
		if (dev['notified'])
			return;
console.log('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF\n');







		// Send notification
		var addr = dev['peripheral'].address;
		var subject = addr + ' needs your attention';
		var body = 'Humidity: ' + dev['humidity'] + ' %\nTemperature: ' +
			dev['temperature'] + ' \u00B0C\n';

		dev['notified'] = true;
		for (var i in monitorTable['Sim']) {
			var phoneInfo = monitorTable['Sim'][i];
			console.log('QQQQQQQQQQQQQQQQQQQQQQQQQQQQ\n');
			SendSMS(phoneInfo, subject, body, function(error) {
				if (error) {
					console.log('\t\tSend SMS to ' + this.number +
						' failed: ' + error);
				} else {
					console.log('\t\tSend SMS to ' + this.number +
						' successfully');
				}
			}.bind( {number:phoneInfo['number']} ));
		}
		dev['notified'] = false;
		dev['records'] = [];
		dev['state'] = 'STATE_INIT';
	}


*/



if (dev['humidity'] >= RH_THRESHOLD){

		var addr = dev['peripheral'].address;
		var subject = addr + ' needs your attention';
		var body = 'H: ' + dev['humidity'] + ' %\nT: ' +
			dev['temperature'] + ' \u00B0C\n';

		dev['notified'] = true;


		if(dev['everbelow'] == true) {
		for (var i in monitorTable['Sim']) {
			var phoneInfo = monitorTable['Sim'][i];
			console.log('QQQQQQQQQQQQQQQQQQQQQQQQQQQQ\n');


/*

			SendSMS(phoneInfo, subject, body, function(error) {
				if (error) {
					console.log('\t\tSend SMS to ' + this.number +
						' failed: ' + error);
				} else {
					console.log('\t\tSend SMS to ' + this.number +
						' successfully');
				}
			}.bind( {number:phoneInfo['number']} ));
*/




			
		}
			}

		
		dev['notified'] = false;
		dev['records'] = [];
		dev['state'] = 'STATE_INIT';
		dev['everbelow'] = false;
}
else{
	dev['everbelow'] = true;
}









	
}

function disconnect(callback) {
	for (addr in gDevices) {
		gDevices[addr]['enabled'] = false;
		gDevices[addr]['peripheral'].disconnect(function() {
			console.log('Disconnected from peripheral: ' + addr + ' (RSSI: ' + gDevices[addr]['rssi'] + ') on ' + new Date());
		});
	}
	setTimeout(callback, 1000);
}

function execCmd(line, callback)
{
	var execFile = require('child_process').execFile;
	var l = line.trim();
	var cmd = l;
	var args = '';
	var space = l.indexOf(' ');
	if (space > 0) {
		cmd = l.substr(0, space);
		args = l.substr(space + 1);
	}
	switch(cmd) {
	case 'exit':
		process.exit(0);
	default:
		//console.log('> ' + cmd, args);
		var arglist = undefined;
		if (args != '') {
			arglist = args.split(' ');
		}
		execFile(cmd, arglist, function(error, stdout, stderr) {
			var output;
			if (error) {
				callback(error, stderr);
				output = error + stderr;
			} else {
				callback(error, stdout);
				output = stdout;
			}
			mqsh.output_pub(os.hostname(), output, function(){});
		});
		break;
	}
}


function pushAWS(addr, vt, vh, callback) {
	var util = require('util');
	var spawn = require('child_process').spawn;
	var execFile = require('child_process').execFile;
	var mosqparam = [
		'--cafile', 'certs/rootCA.pem',
		'--cert', 'certs/keys/certificate.pem',
		'--key', 'certs/keys/private.key',
		'-h', 'a7dsuf6iddqdg.iot.us-west-2.amazonaws.com',
		'-p', '8883'
	];
	var logDate = new Date();
	var postData = {
		datetime: logDate.toISOString(),
		temperature: parseFloat(vt),
		humidity: parseFloat(vh)
	};
	console.log("pushAWS", postData);
	// publish to main data queue (for DynamoDB)
	execFile('mosquitto_pub', mosqparam.concat('-t', 'temp-humidity/Sensor-' + addr, '-m', JSON.stringify(postData)),
		 function(error, stdout, stderr) {
			// published
			callback(false, error);
	});
	// publish to device shadow
	var shadowPayload = {
		state: {
			desired: {
				datetime: logDate.toISOString(),
				temperature: parseFloat(vt),
				humidity: parseFloat(vh)
			}
		}
	};
	execFile('mosquitto_pub', mosqparam.concat('-t','$aws/things/Sensor-' + addr + '/shadow/update', '-m',
		 JSON.stringify(shadowPayload)), function(error, stdout, stderr) {
			// shadow update done
			callback(true, error);
	});
}


// pushAWS and detection algorithm simulation
function simulate() {
	var addr = 'Sim';
	var simDevice = new Device({'address': addr, 'rssi': 0});
	console.log('Start Simulation...');
	setInterval(function() {
		var temp = (Math.random() * (40 - 25) + 25).toFixed(2);
		var humidity = (Math.random() * (100 - 30) + 30).toFixed(2);
		pushAWS(addr, temp, humidity, function(shadow, error) {
			if (error)
				console.log("AWS push error,", error, "shadow:", shadow);
		});
		simDevice['temperature'] = temp;
		simDevice['humidity'] = humidity;
		algo_detection(simDevice);
	}, 2500);
}

noble.on('stateChange', function(state) {
	if (state === 'poweredOn') {
		noble.startScanning();








		
	} else {
		noble.stopScanning();
	}
});

noble.on('discover', function(peripheral) {
	//console.log('111111111111111');
	//console.log('Is_Connecting' + Is_Connecting);
	console.log('peripheral.advertisement.localName' + peripheral.advertisement.localName);
	//console.log('peripheral.rssi' + peripheral.rssi);
	//if ((peripheral.advertisement.localName == "CFX_DIAPER" || peripheral.advertisement.localName == "XuXuKou")&&(peripheral.rssi > -90)&&(!Is_Connecting)) {
    	if ((peripheral.advertisement.localName == "CFX_DIAPER" || peripheral.advertisement.localName == "XuXuKou")&&(peripheral.rssi > -90)) {
		// start connection
		Is_Connecting = true;
		//noble.stopScanning();
		//console.log('stopScanningstopScanningstopScanningstopScanningstopScanningstopScanning');



 



var addr = peripheral.address;

		if (!gDevices[addr])
			gDevices[addr] = new Device(peripheral);

         if(gDevices[addr]['connecting'] == true)
            return;


		gDevices[addr]['connecting'] = true;







        var t = setTimeout(function() {
		
			console.log('ERROR CO0NNECT, Disconnected from peripheral after 5 second');
		
		peripheral.disconnect(function() {
			console.log('Disconnected from peripheral: ' + peripheral.address + 'on ' + new Date());
		});


		noble.stopScanning();

//setTimeout



		noble.startScanning();

		gDevices[addr]['connecting'] = false;
		}, 5000);









		peripheral.connect(function(error) {
			console.log('Connected to ' + peripheral.address + ' (RSSI ' + peripheral.rssi + ') on ' + new Date() + 'error' + error);
			






			
			peripheral.discoverServices(['1809', '6e400001b5a3f393e0a9e50e24dcca9e'], function(error, services) {
				console.log('333333333333333333333' + 'error' + error);


				
				var deviceInformationService = services[0];
				console.log("Discovered Health Thermometer GATT Service");
				deviceInformationService.discoverCharacteristics(['2a1c', '6e400003b5a3f393e0a9e50e24dcca9e'], function(error, characteristics) {
					var temperatureMeasurementCharacteristic = characteristics[0];
					
					console.log('Discovered Temperature Measurement Service');
					
					// enable notify
					temperatureMeasurementCharacteristic.notify(true, function(error) {
						console.log('Temperature Measurement Notification On');
                        gDevices[addr]['enabled'] = true;
                        gDevices[addr]['connecting'] = false;
					});
					Is_Connecting = true;
					
					// subscribe indicate
					temperatureMeasurementCharacteristic.subscribe(function(error) {
						temperatureMeasurementCharacteristic.on('data', function(data, isNotification) {
							var type;
							switch (temperatureMeasurementCharacteristic.uuid) {
							case '2a1c':
								type = 'CFX';
								gDevices[addr]['symbol'] = 'C';
								break;
							case '6e400003b5a3f393e0a9e50e24dcca9e':
							default:
								type = 'XuXuKou';
								gDevices[addr]['symbol'] = 'X';
								break;
							}
							sensorNotification(type, addr, data);
						});

						clearTimeout(t);
						Is_Connecting = false;
						
					});
				});
			});














			
			// handle disconnect event
			peripheral.once('disconnect', function(){
				var address = peripheral.address;
				if (gDevices[address] == undefined)
					noble.startScanning();
				else if (gDevices[address]['enabled']) {
					console.log(address + ' (RSSI: ' + gDevices[address]['rssi'] + ') disconnected on ' + new Date());
					gDevices[address]['enabled'] = false;
					noble.startScanning();
				}
			});
		});

















		
	}
});
















process.on("SIGINT", function() {
	console.log('Receives SIGINT');
	disconnect(function() {
		// exit
		process.exit();
	});
});

function SendEmail(recipient, subject, body, callback) {
	// Use SMTP Protocol to send Email

	let transporter = nodemailer.createTransport({

	/*
		service: 'Gmail',
		auth: {
			type: 'login',
			user: 'chuangfeixin',
			pass: 'www.chuangfeixin.com'
		},
		*/
		host: 'smtp.mxhichina.com',
		secureConnection: true,
    	port:465,
		auth: {
			//type: 'login',
			user: 'huangxu@chuangfeixin.com',
			pass: '123qwe!@#'
		},


	
		debug: false // include SMTP traffic in the logs
	}, {
		// default message fields
		// sender info
		from: 'ElderSens <huangxu@chuangfeixin.com>',
	});

	// Message object
	let message = {
		to: recipient,
		subject: subject,
		text: body,
		html: "<b>" + body + "</b>"
	}

	transporter.sendMail(message, (error, info) => {
		if (error) {
			console.log(error);
			callback(error);
			return;
		} else {
			callback(null);
			//console.log("Message sent: " + info.response);
		}
		transporter.close();
	});
}

function SendSMS(phoneInfo, subject, body, cb) {
	var gateways = {
		'AT&T': 'txt.att.net',
		'Sprint': 'messaging.sprintpcs.com',
		'T-Mobile': 'tmomail.net',
		'ChinaMobile': '139.com',
		'Verizon': 'vtext.com'};
	var carrier = phoneInfo['carrier'];
	var number = phoneInfo['number'];
	body = body + '\n-ElderSens';

	if (gateways[carrier] == undefined) {
		cb("invalid carrier " + carrier);
		return;
	}
	// normalize U.S. phone number
	if (number[0] == '+')
		number = number.substring(1);
	/*
	if (number[0] == '1')
		number = number.substring(1);
/*
	if (number.length != 10) {
		cb("invalid phone number " + number);
		return;
	}
	*/
	if (number.length != 11) {
		cb("invalid phone number " + number);
		return;
	}

	recipient = number + '@' + gateways[carrier];
	SendEmail(recipient, subject, body, cb);
}

setInterval(function() {
	for (addr in gDevices) {
		if (gDevices[addr]['enabled']) {
			var peripheral = gDevices[addr]['peripheral'];
			peripheral.updateRssi(function(error, rssi) {
				if (!error)
					gDevices[addr]['rssi'] = rssi;
				noble.startScanning();
			});
		}
	}
}, 1000);

// handle MQTT management
mqsh.input_sub(os.hostname(), function(sub) {
	sub.stdout.on('data', (data) => {
		execCmd(data.toString(), function(error, output) {
			//if (error)
			//	console.log(error);
			//console.log(output);
		});
	});
	sub.stderr.on('data', (data) => {
		console.log('error: ' + data.toString());
	});
	sub.on('close', (code) => {
		if (code)
			console.log('exit: ' + code);
	});
});

module.exports.simulate = simulate;
