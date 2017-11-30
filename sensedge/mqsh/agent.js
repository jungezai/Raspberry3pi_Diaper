const mqsh = require('../mqpubsub.js');

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
		console.log('> ' + cmd, args);
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
			mqsh.output_pub(addr, output, function(){});
		});
		break;
	}
}

var addr = 'Sim';
if (process.argv.length > 2)
	addr = process.argv[2];

mqsh.input_sub(addr, function(sub) {
	sub.stdout.on('data', (data) => {
		execCmd(data.toString(), function(error, output) {
			if (error)
				console.log(error);

			console.log(output);
		});
	});

	sub.stderr.on('data', (data) => {
		console.log('error: ' + data.toString());
	});

	sub.on('close', (code) => {
		console.log('exit: ' + code.toString());
	});
});
