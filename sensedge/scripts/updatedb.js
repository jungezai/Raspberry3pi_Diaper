var mysql = require('mysql');

var con = mysql.createConnection({
	host: "kittycat9.local",
	user: "eldersens",
	password: "ElderSens123",
	database: "dsdb"
});

con.connect(function(err) {
	if (err) throw err;
	console.log("Connected!");
	var sql = "insert into diapersens_tbl(ts, addr,temp,humidity) values(now(), 'Nodejs', rand()*100, rand()*100)";
	con.query(sql, function(err, result) {
		if (err)
			throw err;
		console.log("inserted successfully");
		con.end();
	});
});
