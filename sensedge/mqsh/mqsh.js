const readline = require('readline');
var mqsh = require('../mqpubsub.js');

var addr = 'Sim';
if (process.argv.length > 2)
	addr = process.argv[2];

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
	prompt: addr + ' > ',
});

rl.prompt();

rl.on('line', (line) => {
	var execFile = require('child_process').execFile;
	var l = line.trim();
	var cmd = l;
	var space = l.indexOf(' ');
	if (space > 0) {
		cmd = l.substr(0, space);
	}
	switch(cmd) {
	case 'exit':
		process.exit(0);
	default:
		//console.log('exec:', l);
		mqsh.input_pub(addr, l, function(){});
		break;
	}
}).on('close', () => {
	console.log('bye!');
	process.exit(0);
});

mqsh.output_sub(addr, function(sub) {
	sub.stdout.on('data', (data) => {
		process.stdout.write(data.toString());
		rl.prompt();
	});

	sub.stderr.on('data', (data) => {
		process.stderr.write('error: ' + data.toString());
		rl.prompt();
	});

	sub.on('close', (code) => {
		console.log('exit: ' + code.toString());
	});
});
