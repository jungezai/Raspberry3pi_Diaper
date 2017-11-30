const mosqparam = [
	'--cafile', 'certs/rootCA.pem',
	'--cert', 'certs/keys/certificate.pem',
	'--key', 'certs/keys/private.key',
	'-h', 'a7dsuf6iddqdg.iot.us-west-2.amazonaws.com',
	'-p', '8883'
];
const execFile = require('child_process').execFile;
const spawn = require('child_process').spawn;

exports.input_pub = function(hub, msg, callback) {
	execFile('mosquitto_pub', mosqparam.concat('-t', 'DiaperSens-' + hub + '/input', '-m', msg),
		function(error, stdout, stderr) {
			// published
			callback(false, error);
	});
}
exports.input_sub = function(hub, cb) {
	var sub = spawn('mosquitto_sub', mosqparam.concat('-t', 'DiaperSens-' + hub + '/input'));
	cb(sub);
}

exports.output_pub = function(hub, msg, callback) {
	execFile('mosquitto_pub', mosqparam.concat('-t', 'DiaperSens-' + hub + '/output', '-m', msg),
		function(error, stdout, stderr) {
			// published
			callback(false, error);
	});
}
exports.output_sub = function(hub, cb) {
	var sub = spawn('mosquitto_sub', mosqparam.concat('-t', 'DiaperSens-' + hub + '/output'));
	cb(sub);
}
