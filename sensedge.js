var os = require('os');
var noble = require('noble');
var nodemailer = require('nodemailer');
var ip = require('ip');
var mqsh = require('./mqpubsub.js');
var mysql = require('mysql');

// Constant
const TYPE_DIAPERSENS =	1
const TYPE_FALLSENS   = 2
// SMS Phonebook
const u1_carrier = 'AT&T';
const u1_number = '1234567';
const u2_carrier = 'Verizon';
const u2_number = '1234567';
const u3_carrier = 'T-Mobile';
const u3_number = '1234567';

const phoneBook = {
	'Yi':		{ 'carrier': 'T-Mobile', 'number': '4083178351' },
	'Li':		{ 'carrier': 'Verizon',  'number': '2082720078' },
	'George':	{ 'carrier': 'Verizon',  'number': '5105661442' },
	'1':		{ 'carrier': u1_carrier, 'number': u1_number    },
	'2':		{ 'carrier': u2_carrier, 'number': u2_number    },
	'3':		{ 'carrier': u3_carrier, 'number': u3_number    },
};
const monitorTable = {
	'e6:d7:22:59:ed:ed' : [ phoneBook['Li'], phoneBook['Yi'] ],
	'fc:a1:c8:c2:b4:af' : [ phoneBook['Li'], phoneBook['Yi'] ],
	'd7:9a:ae:73:3b:94' : [ phoneBook['Li'], phoneBook['Yi'] ],
	'fe:2f:47:bd:a0:f9' : [ phoneBook['Li'], phoneBook['Yi'] ],
	'e4:d9:80:62:26:e6' : [ phoneBook['Li'], phoneBook['Yi'] ],
	'f7:b7:2a:a1:da:b6' : [ phoneBook['Li'], phoneBook['Yi'] ],
};

// DiaperSens Constant
const RH_THRESHOLD = 80
// DiaperSens Detection Algorithm
const ALGO_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
const ALGO_TEMPRAMP_MS = 2 * 60 * 1000; // 2 minutes
const ALGO_TEMPRAMP_VALUE = 0.5; // 0.5 Celsius

// FallSens Constant
const GRAVITY = 9.8;
const FALL_THRESHOLD = 24.5;
const CALIBRATE_COUNT = 300;

var gConfig = { 'bootNotification': {
			'enable': false,
			'os': 'linux',
			'uptime': 60,
			'recipient': phoneBook['Li']
		},
		'smsNotification': false,
		'cloudUpdate': true,
		'useAlgorithm': false,
		'localDBUpdate': false,
		'dbHost': 'kittycat9.local',
		'dbPasswd': 'ElderSens123',
};
var gDevices = {};
var gResetting = false;
var gState;
var gCalibrate = true;//false;
var gCalibrateDevice = null;

// FallSens device Calibration Table
const calibrationTable = {
	// Mac Address,	    Axis X,	  Y,	   Z	    SVM Threshold
	'e6:d7:22:59:ed:ed' : [  3.0097,  0.3852,  2.0977,  15.5 ],
	'fc:a1:c8:c2:b4:af' : [  18.6608, 3.4489,  2.8866,  20.5 ],
	'd7:9a:ae:73:3b:94' : [  6.5987,  3.8231,  1.1636,  24.5 ],
};

// Function libraries
function Device(peripheral) {
	this.peripheral		= peripheral;
	this.type		= 0;
	// DiaperSens
	this.temperature	= 0;
	this.humidity		= 0;
	// DiaperSens detection algorithm related
	this.state		= 'STATE_INIT';
	this.rh_start		= 0;
	this.records		= [];
	// FallSens
	this.acc_triggered	= false;
	this.acc_buffer		= [];
	this.nsample		= 0;
	this.calib_axis		= [ 0, 0, 0 ];
	// Common
	this.rssi		= peripheral.rssi;
	this.enabled		= false;
	this.notified		= false;
	this.connecting		= false;
	this.tsconn		= (new Date()).getTime();
	this.TXPower		= peripheral.advertisement.txPowerLevel;
}

function doNotification(dev) {
	if (gConfig['useAlgorithm']) {
		algo_detection(dev);
	} else {
		if (dev['humidity'] >= RH_THRESHOLD) {
			if (!dev['notified']) {
				dev['notified'] = true;
				sendNotification(dev);
			}
		} else {
			dev['notified'] = false;
		}
	}
}

function detectFall(addr, buf) {
	var t0 = buf[0]['ts'];
	console.log("Dump", addr, "samples since", new Date(t0).toLocaleString());
	var sum = [ 0, 0, 0 ];
	var count = 0;
	var fall = false;
	for (var i = 0; i < buf.length; i++) {
		var entry = buf[i];
		console.log("\tTS", entry['ts'] - t0, "SVM", entry['svm'].toFixed(2),
			    "XYZ {", entry['axis'][0].toFixed(2),
			    entry['axis'][1].toFixed(2),
			    entry['axis'][2].toFixed(2), "}");
		if (entry['ts'] - t0 >= 400) {
			count++;
			for (var j = 0; j < 3; j++) {
				sum[j] += entry['axis'][j];
			}
		}
	}
	if (count > 0) {
		if ((Math.abs(sum[0] / count) > 5 || Math.abs(sum[2] / count) > 5) &&
		    Math.abs(sum[1] / count) < 5) {
			fall = true;
		}
		console.log(addr, ": AvgX", (sum[0] / count).toFixed(2),
			    ", AvgY", (sum[1] / count).toFixed(2),
			    ", AvgZ", (sum[2] / count).toFixed(2),
			    ", count", count, ", fall", fall);
	}
	return fall;
}

function sendBootNotification() {
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
}

function processDiaperSens(addr, dev, data) {
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
		dev['temperature'] = temperature;
		dev['humidity'] = humidity;
		break;
	case 2:
		var unused_value = data.readInt8(2);
		return;
	}
}


//var vec3d = {
//'x':null,
//'y':null,
//'z':null,
//};
//
//vec3d ancArray;
//
//var distance_struct_t = {
//'r':null,
//'count':null,
//};
//
//const TRILATERATION = 1;
//const REGRESSION_NUM = 10;
//const SPEED_OF_LIGHT = 299702547.0;   // in m/s in air
//const NUM_ANCHORS = 5;
//const REF_ANCHOR = 5;	//anchor IDs are 1,2,3,4,5 etc. (don't start from 0!)
//
//const TRIL_3SPHERES = 3;
//const TRIL_4SPHERES = 4;
//
//
//
//
//
///* Return the difference of two vectors, (vector1 - vector2). */
//vec3d vdiff(const vec3d vector1, const vec3d vector2)
//{
//	vec3d v;
//	v.x = vector1.x - vector2.x;
//	v.y = vector1.y - vector2.y;
//	v.z = vector1.z - vector2.z;
//	return v;
//}
//
///* Return the sum of two vectors. */
//vec3d vsum(const vec3d vector1, const vec3d vector2)
//{
//	vec3d v;
//	v.x = vector1.x + vector2.x;
//	v.y = vector1.y + vector2.y;
//	v.z = vector1.z + vector2.z;
//	return v;
//}
//
///* Multiply vector by a number. */
//vec3d vmul(const vec3d vector, const double n)
//{
//	vec3d v;
//	v.x = vector.x * n;
//	v.y = vector.y * n;
//	v.z = vector.z * n;
//	return v;
//}
//
///* Divide vector by a number. */
//vec3d vdiv(const vec3d vector, const double n)
//{
//	vec3d v;
//	v.x = vector.x / n;
//	v.y = vector.y / n;
//	v.z = vector.z / n;
//	return v;
//}
//
///* Return the Euclidean norm. */
//double vdist(const vec3d v1, const vec3d v2)
//{
//	double xd = v1.x - v2.x;
//	double yd = v1.y - v2.y;
//	double zd = v1.z - v2.z;
//	return sqrt(xd * xd + yd * yd + zd * zd);
//}
//
///* Return the Euclidean norm. */
//double vnorm(const vec3d vector)
//{
//	return sqrt(vector.x * vector.x + vector.y * vector.y + vector.z * vector.z);
//}
//
///* Return the dot product of two vectors. */
//double dot(const vec3d vector1, const vec3d vector2)
//{
//	return vector1.x * vector2.x + vector1.y * vector2.y + vector1.z * vector2.z;
//}
//
///* Replace vector with its cross product with another vector. */
//vec3d cross(const vec3d vector1, const vec3d vector2)
//{
//	vec3d v;
//	v.x = vector1.y * vector2.z - vector1.z * vector2.y;
//	v.y = vector1.z * vector2.x - vector1.x * vector2.z;
//	v.z = vector1.x * vector2.y - vector1.y * vector2.x;
//	return v;
//}
//
///* Return the GDOP (Geometric Dilution of Precision) rate between 0-1.
//* Lower GDOP rate means better precision of intersection.
//*/
//double gdoprate(const vec3d tag, const vec3d p1, const vec3d p2, const vec3d p3)
//{
//	vec3d ex, t1, t2, t3;
//	var  h, gdop1, gdop2, gdop3, result;
//
//	ex = vdiff(p1, tag);
//	h = vnorm(ex);
//	t1 = vdiv(ex, h);
//
//	ex = vdiff(p2, tag);
//	h = vnorm(ex);
//	t2 = vdiv(ex, h);
//
//	ex = vdiff(p3, tag);
//	h = vnorm(ex);
//	t3 = vdiv(ex, h);
//
//	gdop1 = fabs(dot(t1, t2));
//	gdop2 = fabs(dot(t2, t3));
//	gdop3 = fabs(dot(t3, t1));
//
//	if (gdop1 < gdop2) result = gdop2; else result = gdop1;
//	if (result < gdop3) result = gdop3;
//
//	return result;
//}
//
///* Intersecting a sphere sc with radius of r, with a line p1-p2.
//* Return zero if successful, negative error otherwise.
//* mu1 & mu2 are constant to find points of intersection.
//*/
//int sphereline(const vec3d p1, const vec3d p2, const vec3d sc, double r, double *const mu1, double *const mu2)
//{
//	var a, b, c;
//	var bb4ac;
//	vec3d dp;
//
//	dp.x = p2.x - p1.x;
//	dp.y = p2.y - p1.y;
//	dp.z = p2.z - p1.z;
//
//	a = dp.x * dp.x + dp.y * dp.y + dp.z * dp.z;
//
//	b = 2 * (dp.x * (p1.x - sc.x) + dp.y * (p1.y - sc.y) + dp.z * (p1.z - sc.z));
//
//	c = sc.x * sc.x + sc.y * sc.y + sc.z * sc.z;
//	c += p1.x * p1.x + p1.y * p1.y + p1.z * p1.z;
//	c -= 2 * (sc.x * p1.x + sc.y * p1.y + sc.z * p1.z);
//	c -= r * r;
//
//	bb4ac = b * b - 4 * a * c;
//
//	if (fabs(a) == 0 || bb4ac < 0) {
//		*mu1 = 0;
//		*mu2 = 0;
//		return -1;
//	}
//
//	*mu1 = (-b + sqrt(bb4ac)) / (2 * a);
//	*mu2 = (-b - sqrt(bb4ac)) / (2 * a);
//
//	return 0;
//}
//
///* Return TRIL_3SPHERES if it is performed using 3 spheres and return
//* TRIL_4SPHERES if it is performed using 4 spheres
//* For TRIL_3SPHERES, there are two solutions: result1 and result2
//* For TRIL_4SPHERES, there is only one solution: best_solution
//*
//* Return negative number for other errors
//*
//* To force the function to work with only 3 spheres, provide a duplicate of
//* any sphere at any place among p1, p2, p3 or p4.
//*
//* The last parameter is the largest nonnegative number considered zero;
//* it is somewhat analogous to machine epsilon (but inclusive).
//*/
//int trilateration(vec3d *const result1,
//		vec3d *const result2,
//		vec3d *const best_solution,
//		const vec3d p1, const double r1,
//		const vec3d p2, const double r2,
//		const vec3d p3, const double r3,
//		const vec3d p4, const double r4,
//		const double maxzero)
//{
//	vec3d	ex, ey, ez, t1, t2, t3;
//	var	h, i, j, x, y, z, t;
//	var	mu1, mu2, mu;
//	var	result;
//	var	rr4=0.0;
//	var	count4 = 0;
//	
//	/*********** FINDING TWO POINTS FROM THE FIRST THREE SPHERES **********/
//
//	// if there are at least 2 concentric spheres within the first 3 spheres
//	// then the calculation may not continue, drop it with error -1
//
//	/* h = |p3 - p1|, ex = (p3 - p1) / |p3 - p1| */
//	ex = vdiff(p3, p1); // vector p13 判断p1，p3两点是否重合 同心圆
//	h = vnorm(ex); // scalar p13
//	if (h <= maxzero) {
//		/* p1 and p3 are concentric, not good to obtain a precise intersection point */
//		//printf("concentric13 return -1\n");
//		return ERR_TRIL_CONCENTRIC;
//	}
//
//	/* h = |p3 - p2|, ex = (p3 - p2) / |p3 - p2| */
//	ex = vdiff(p3, p2); // vector p23
//	h = vnorm(ex); // scalar p23
//	if (h <= maxzero) {
//		/* p2 and p3 are concentric, not good to obtain a precise intersection point */
//		//printf("concentric23 return -1\n");
//		return ERR_TRIL_CONCENTRIC;
//	}
//
//	/* h = |p2 - p1|, ex = (p2 - p1) / |p2 - p1| */
//	ex = vdiff(p2, p1); // vector p12
//	h = vnorm(ex); // scalar p12
//	if (h <= maxzero) {
//		/* p1 and p2 are concentric, not good to obtain a precise intersection point */
//		//printf("concentric12 return -1\n");
//		return ERR_TRIL_CONCENTRIC;
//	}
//	ex = vdiv(ex, h); // unit vector ex with respect to p1 (new coordinate system)
//
//
//					  /* t1 = p3 - p1, t2 = ex (ex . (p3 - p1)) */
//	t1 = vdiff(p3, p1); // vector p13
//	i = dot(ex, t1); // the scalar of t1 on the ex direction
//	t2 = vmul(ex, i); // colinear vector to p13 with the length of i
//
//					  /* ey = (t1 - t2), t = |t1 - t2| */
//	ey = vdiff(t1, t2); // vector t21 perpendicular to t1
//	t = vnorm(ey); // scalar t21
//	if (t > maxzero) {
//		/* ey = (t1 - t2) / |t1 - t2| */
//		ey = vdiv(ey, t); // unit vector ey with respect to p1 (new coordinate system)
//
//						  /* j = ey . (p3 - p1) */
//		j = dot(ey, t1); // scalar t1 on the ey direction
//	}
//	else
//		j = 0.0;
//
//	/* Note: t <= maxzero implies j = 0.0. */
//	if (fabs(j) <= maxzero) {
//
//		/* Is point p1 + (r1 along the axis) the intersection? */
//		t2 = vsum(p1, vmul(ex, r1));
//		if (fabs(vnorm(vdiff(p2, t2)) - r2) <= maxzero &&
//			fabs(vnorm(vdiff(p3, t2)) - r3) <= maxzero) {
//			/* Yes, t2 is the only intersection point. */
//			if (result1)
//				*result1 = t2;
//			if (result2)
//				*result2 = t2;
//			return TRIL_3SPHERES;
//		}
//
//		/* Is point p1 - (r1 along the axis) the intersection? */
//		t2 = vsum(p1, vmul(ex, -r1));
//		if (fabs(vnorm(vdiff(p2, t2)) - r2) <= maxzero &&
//			fabs(vnorm(vdiff(p3, t2)) - r3) <= maxzero) {
//			/* Yes, t2 is the only intersection point. */
//			if (result1)
//				*result1 = t2;
//			if (result2)
//				*result2 = t2;
//			return TRIL_3SPHERES;
//		}
//		/* p1, p2 and p3 are colinear with more than one solution */
//		return ERR_TRIL_COLINEAR_2SOLUTIONS;
//	}
//
//	/* ez = ex x ey */
//	ez = cross(ex, ey); // unit vector ez with respect to p1 (new coordinate system)
//
//	x = (r1*r1 - r2*r2) / (2 * h) + h / 2;
//	y = (r1*r1 - r3*r3 + i*i) / (2 * j) + j / 2 - x * i / j;
//	z = r1*r1 - x*x - y*y;
//	//printf("i=%.3f\r\n", i);
//	//printf("j=%.3f\r\n", j);
//	//printf("h=%.3f\r\n", h);
//	//printf("x=%.3f\r\n", x);
//	//printf("y=%.3f\r\n", y);
//	//printf("z=%.3f\r\n", z);
//	if (z < -maxzero) {
//		/* The solution is invalid, square root of negative number */
//		return ERR_TRIL_SQRTNEGNUMB;
//	}
//	else
//		if (z > 0.0)
//			z = sqrt(z);
//		else
//			z = 0.0;
//
//	/* t2 = p1 + x ex + y ey */
//	t2 = vsum(p1, vmul(ex, x));
//	t2 = vsum(t2, vmul(ey, y));
//
//	/* result1 = p1 + x ex + y ey + z ez */
//	if (result1)
//		*result1 = vsum(t2, vmul(ez, z));
//
//	/* result1 = p1 + x ex + y ey - z ez */
//	if (result2)
//		*result2 = vsum(t2, vmul(ez, -z));
//
//	/*********** END OF FINDING TWO POINTS FROM THE FIRST THREE SPHERES **********/
//	/********* RESULT1 AND RESULT2 ARE SOLUTIONS, OTHERWISE RETURN ERROR *********/
//
//
//	/************* FINDING ONE SOLUTION BY INTRODUCING ONE MORE SPHERE ***********/
//
//	// check for concentricness of sphere 4 to sphere 1, 2 and 3
//	// if it is concentric to one of them, then sphere 4 cannot be used
//	// to determine the best solution and return -1
//
//	/* h = |p4 - p1|, ex = (p4 - p1) / |p4 - p1| */
//	ex = vdiff(p4, p1); // vector p14
//	h = vnorm(ex); // scalar p14
//	if (h <= maxzero) {
//		/* p1 and p4 are concentric, not good to obtain a precise intersection point */
//		//printf("concentric14 return 0\n");
//		return TRIL_3SPHERES;
//	}
//	/* h = |p4 - p2|, ex = (p4 - p2) / |p4 - p2| */
//	ex = vdiff(p4, p2); // vector p24
//	h = vnorm(ex); // scalar p24
//	if (h <= maxzero) {
//		/* p2 and p4 are concentric, not good to obtain a precise intersection point */
//		//printf("concentric24 return 0\n");
//		return TRIL_3SPHERES;
//	}
//	/* h = |p4 - p3|, ex = (p4 - p3) / |p4 - p3| */
//	ex = vdiff(p4, p3); // vector p34
//	h = vnorm(ex); // scalar p34
//	if (h <= maxzero) {
//		/* p3 and p4 are concentric, not good to obtain a precise intersection point */
//		//printf("concentric34 return 0\n");
//		return TRIL_3SPHERES;
//	}
//
//	// if sphere 4 is not concentric to any sphere, then best solution can be obtained
//	/* find i as the distance of result1 to p4 */
//	t3 = vdiff(*result1, p4);
//	i = vnorm(t3);
//	/* find h as the distance of result2 to p4 */
//	t3 = vdiff(*result2, p4);
//	h = vnorm(t3);
//
//	/* pick the result1 as the nearest point to the center of sphere 4 */
//	if (i > h) {
//		*best_solution = *result1;
//		*result1 = *result2;
//		*result2 = *best_solution;
//	}
//
//	
//	rr4 = r4;
//	result = 1;
//	/* intersect result1-result2 vector with sphere 4 */
//	while (result && count4 < 10)
//	{
//		result = sphereline(*result1, *result2, p4, rr4, &mu1, &mu2);
//		rr4 += 0.1;
//		count4++;
//	}
//
//	if (result) {
//
//		/* No intersection between sphere 4 and the line with the gradient of result1-result2! */
//		*best_solution = *result1; // result1 is the closer solution to sphere 4
//								   //return ERR_TRIL_NOINTERSECTION_SPHERE4;
//
//	}
//	else {
//
//		if (mu1 < 0 && mu2 < 0) {
//
//			/* if both mu1 and mu2 are less than 0 */
//			/* result1-result2 line segment is outside sphere 4 with no intersection */
//			if (fabs(mu1) <= fabs(mu2)) mu = mu1; else mu = mu2;
//			/* h = |result2 - result1|, ex = (result2 - result1) / |result2 - result1| */
//			ex = vdiff(*result2, *result1); // vector result1-result2
//			h = vnorm(ex); // scalar result1-result2
//			ex = vdiv(ex, h); // unit vector ex with respect to result1 (new coordinate system)
//							  /* 50-50 error correction for mu */
//			mu = 0.5*mu;
//			/* t2 points to the intersection */
//			t2 = vmul(ex, mu*h);
//			t2 = vsum(*result1, t2);
//			/* the best solution = t2 */
//			*best_solution = t2;
//
//		}
//		else if ((mu1 < 0 && mu2 > 1) || (mu2 < 0 && mu1 > 1)) {
//
//			/* if mu1 is less than zero and mu2 is greater than 1, or the other way around */
//			/* result1-result2 line segment is inside sphere 4 with no intersection */
//			if (mu1 > mu2) mu = mu1; else mu = mu2;
//			/* h = |result2 - result1|, ex = (result2 - result1) / |result2 - result1| */
//			ex = vdiff(*result2, *result1); // vector result1-result2
//			h = vnorm(ex); // scalar result1-result2
//			ex = vdiv(ex, h); // unit vector ex with respect to result1 (new coordinate system)
//							  /* t2 points to the intersection */
//			t2 = vmul(ex, mu*h);
//			t2 = vsum(*result1, t2);
//			/* vector t2-result2 with 50-50 error correction on the length of t3 */
//			t3 = vmul(vdiff(*result2, t2), 0.5);
//			/* the best solution = t2 + t3 */
//			*best_solution = vsum(t2, t3);
//
//		}
//		else if (((mu1 > 0 && mu1 < 1) && (mu2 < 0 || mu2 > 1))
//			|| ((mu2 > 0 && mu2 < 1) && (mu1 < 0 || mu1 > 1))) {
//
//			/* if one mu is between 0 to 1 and the other is not */
//			/* result1-result2 line segment intersects sphere 4 at one point */
//			if (mu1 >= 0 && mu1 <= 1) mu = mu1; else mu = mu2;
//			/* add or subtract with 0.5*mu to distribute error equally onto every sphere */
//			if (mu <= 0.5) mu -= 0.5*mu; else mu -= 0.5*(1 - mu);
//			/* h = |result2 - result1|, ex = (result2 - result1) / |result2 - result1| */
//			ex = vdiff(*result2, *result1); // vector result1-result2
//			h = vnorm(ex); // scalar result1-result2
//			ex = vdiv(ex, h); // unit vector ex with respect to result1 (new coordinate system)
//							  /* t2 points to the intersection */
//			t2 = vmul(ex, mu*h);
//			t2 = vsum(*result1, t2);
//			/* the best solution = t2 */
//			*best_solution = t2;
//
//		}
//		else if (mu1 == mu2) {
//
//			/* if both mu1 and mu2 are between 0 and 1, and mu1 = mu2 */
//			/* result1-result2 line segment is tangential to sphere 4 at one point */
//			mu = mu1;
//			/* add or subtract with 0.5*mu to distribute error equally onto every sphere */
//			if (mu <= 0.25) mu -= 0.5*mu;
//			else if (mu <= 0.5) mu -= 0.5*(0.5 - mu);
//			else if (mu <= 0.75) mu -= 0.5*(mu - 0.5);
//			else mu -= 0.5*(1 - mu);
//			/* h = |result2 - result1|, ex = (result2 - result1) / |result2 - result1| */
//			ex = vdiff(*result2, *result1); // vector result1-result2
//			h = vnorm(ex); // scalar result1-result2
//			ex = vdiv(ex, h); // unit vector ex with respect to result1 (new coordinate system)
//							  /* t2 points to the intersection */
//			t2 = vmul(ex, mu*h);
//			t2 = vsum(*result1, t2);
//			/* the best solution = t2 */
//			*best_solution = t2;
//
//		}
//		else {
//
//			/* if both mu1 and mu2 are between 0 and 1 */
//			/* result1-result2 line segment intersects sphere 4 at two points */
//
//			//return ERR_TRIL_NEEDMORESPHERE;
//
//			mu = mu1 + mu2;
//			/* h = |result2 - result1|, ex = (result2 - result1) / |result2 - result1| */
//			ex = vdiff(*result2, *result1); // vector result1-result2
//			h = vnorm(ex); // scalar result1-result2
//			ex = vdiv(ex, h); // unit vector ex with respect to result1 (new coordinate system)
//							  /* 50-50 error correction for mu */
//			mu = 0.5*mu;
//			/* t2 points to the intersection */
//			t2 = vmul(ex, mu*h);
//			t2 = vsum(*result1, t2);
//			/* the best solution = t2 */
//			*best_solution = t2;
//
//		}
//
//	}
//
//	return TRIL_4SPHERES;
//
//	/******** END OF FINDING ONE SOLUTION BY INTRODUCING ONE MORE SPHERE *********/
//}
//
//
//
//
//
///* This function calls trilateration to get the best solution.
//*
//* If any three spheres does not produce valid solution,
//* then each distance is increased to ensure intersection to happens.
//*
//* Return the selected trilateration mode between TRIL_3SPHERES or TRIL_4SPHERES
//* For TRIL_3SPHERES, there are two solutions: solution1 and solution2
//* For TRIL_4SPHERES, there is only one solution: best_solution
//*
//* nosolution_count = the number of failed attempt before intersection is found
//* by increasing the sphere diameter.
//*/
//var deca_3dlocate(vec3d	*const solution1,
//		vec3d	*const solution2,
//		vec3d	*const best_solution,
//		var	*const nosolution_count,
//		var	*const best_3derror,
//		var	*const best_gdoprate,
//		vec3d p1, var r1,
//		vec3d p2, var r2,
//		vec3d p3, var r3,
//		vec3d p4, var r4,
//		var *combination)
//{
//	vec3d	o1, o2, solution, ptemp;
//	vec3d	solution_compare1, solution_compare2;
//	var	/*error_3dcompare1, error_3dcompare2,*/ rtemp;
//	var	gdoprate_compare1, gdoprate_compare2;
//	var	ovr_r1, ovr_r2, ovr_r3, ovr_r4;
//	var	overlook_count, combination_counter;
//	var	trilateration_errcounter, trilateration_mode34;
//	var	success, concentric, result,i=10;
//
//	trilateration_errcounter = 0;
//	trilateration_mode34 = 0;
//
//	combination_counter = 4; /* four spheres combination */
//
//	*best_gdoprate = 1; /* put the worst gdoprate init */
//	gdoprate_compare1 = 1; gdoprate_compare2 = 1;
//	solution_compare1.x = 0; solution_compare1.y = 0; solution_compare1.z = 0;
//	//error_3dcompare1 = 0;
//
//	do {
//		success = 0;
//		concentric = 0;
//		overlook_count = 0;
//		ovr_r1 = r1; ovr_r2 = r2; ovr_r3 = r3; ovr_r4 = r4;
//
//		do {
//			result = trilateration(&o1, &o2, &solution, p1, ovr_r1, p2, ovr_r2, p3, ovr_r3, p4, ovr_r4, MAXZERO);
//
//			switch (result)
//			{
//			case TRIL_3SPHERES: // 3 spheres are used to get the result
//				trilateration_mode34 = TRIL_3SPHERES;
//				success = 1;
//				break;
//
//			case TRIL_4SPHERES: // 4 spheres are used to get the result
//				trilateration_mode34 = TRIL_4SPHERES;
//				success = 1;
//				break;
//
//			case ERR_TRIL_CONCENTRIC:
//				concentric = 1;
//				break;
//
//			default: // any other return value goes here
//				ovr_r1 += 0.10;
//				ovr_r2 += 0.10;
//				ovr_r3 += 0.10;
//				ovr_r4 += 0.10;
//				overlook_count++;
//				break;
//			}
//
//			//qDebug() << "while(!success)" << overlook_count << concentric << "result" << result;
//
//		} while (!success && (overlook_count <= 5) && !concentric);
//
//
//		if (success)
//		{
//			switch (result)
//			{
//			case TRIL_3SPHERES:
//				*solution1 = o1;
//				*solution2 = o2;
//				*nosolution_count = overlook_count;
//
//				combination_counter = 0;
//				break;
//
//			case TRIL_4SPHERES:
//				/* calculate the new gdop */
//				gdoprate_compare1 = gdoprate(solution, p1, p2, p3);
//
//				/* compare and swap with the better result */
//				if (gdoprate_compare1 <= gdoprate_compare2) 
//				{
//
//					*solution1 = o1;
//					*solution2 = o2;
//					*best_solution = solution;
//					*nosolution_count = overlook_count;
//					*best_3derror = sqrt(   (vnorm(vdiff(solution, p1)) - r1)*(vnorm(vdiff(solution, p1)) - r1) +
//								(vnorm(vdiff(solution, p2)) - r2)*(vnorm(vdiff(solution, p2)) - r2) +
//								(vnorm(vdiff(solution, p3)) - r3)*(vnorm(vdiff(solution, p3)) - r3) +
//								(vnorm(vdiff(solution, p4)) - r4)*(vnorm(vdiff(solution, p4)) - r4));
//					*best_gdoprate = gdoprate_compare1;
//
//					/* save the previous result */
//					solution_compare2 = solution_compare1;
//					//error_3dcompare2 = error_3dcompare1;
//					gdoprate_compare2 = gdoprate_compare1;
//
//					*combination = 5 - combination_counter;
//
//					ptemp = p1; p1 = p2; p2 = p3; p3 = p4; p4 = ptemp;
//					rtemp = r1; r1 = r2; r2 = r3; r3 = r4; r4 = rtemp;
//					combination_counter--;
//
//				}
//				break;
//
//			default:
//				break;
//			}
//		}
//		else
//		{
//			//trilateration_errcounter++;
//			trilateration_errcounter = 4;
//			combination_counter = 0;
//		}
//
//		//ptemp = p1; p1 = p2; p2 = p3; p3 = p4; p4 = ptemp;
//		//rtemp = r1; r1 = r2; r2 = r3; r3 = r4; r4 = rtemp;
//		//combination_counter--;
//		//qDebug() << "while(combination_counter)" << combination_counter;
//	//	printf("combination_counter=%d\r\n", combination_counter);
//
//	} while (combination_counter);
//	
//	// if it gives error for all 4 sphere combinations then no valid result is given
//	// otherwise return the trilateration mode used
//	if (trilateration_errcounter >= 4) return -1; else return trilateration_mode34;
//
//}
////anchorArray	 (m)  基站坐标
////distanceArray	 (mm) 标签-基站距离
//int GetLocation(vec3d *best_solution, var use4thAnchor, vec3d* anchorArray, vec3d *distanceArray)
//{
//
//	vec3d	o1, o2, p1, p2, p3, p4;
//	var	r1 = 0, r2 = 0, r3 = 0, r4 = 0, best_3derror, best_gdoprate;
//	var		result;
//	var     error, combination;
//
//	vec3d	t3;
//	var	dist1, dist2;
//
//	/* Anchors coordinate */
//	p1.x = anchorArray[0].x;		p1.y = anchorArray[0].y;	p1.z = anchorArray[0].z;
//	p2.x = anchorArray[1].x;		p2.y = anchorArray[1].y;	p2.z = anchorArray[1].z;
//	p3.x = anchorArray[2].x;		p3.y = anchorArray[2].y;	p3.z = anchorArray[2].z;
//	p4.x = anchorArray[0].x;		p4.y = anchorArray[0].y;	p4.z = anchorArray[0].z; //4th same as 1st - only 3 used for trilateration
//
////	r1 = (double)2500/ 1000.0;
////	r2 = (double)2500 / 1000.0;
////	r3 = (double)2500 / 1000.0;
////	r4 = (double)2500 / 1000.0;
//
//	r1 = (double)distanceArray[0] / 1000.0;
//	r2 = (double)distanceArray[1] / 1000.0;
//	r3 = (double)distanceArray[2] / 1000.0;
//	r4 = (double)distanceArray[3] / 1000.0;
//
//	console.log("B	 distanceArray",r1.toFixed(2),r2.toFixed(2),r3.toFixed(2),r4.toFixed(2));
//	//qDebug() << "GetLocation" << r1 << r2 << r3 << r4;
//
//	if(use4thAnchor==0){
//        r4 = r1;
//
//	/* get the best location using 3 or 4 spheres and keep it as know_best_location */
//	result = deca_3dlocate(&o1, &o2, best_solution, &error, &best_3derror, &best_gdoprate,
//		p1, r1, p2, r2, p3, r3, p4, r4, &combination);
//
//
//	//qDebug() << "GetLocation" << result << "sol1: " << o1.x << o1.y << o1.z << " sol2: " << o2.x << o2.y << o2.z;
//
//	if (result >= 0)
//	{
//		if (use4thAnchor == 1) //if have 4 ranging results, then use 4th anchor to pick solution closest to it
//		{
//			double diff1, diff2;
//			/* find dist1 as the distance of o1 to known_best_location */
//			t3 = vdiff(o1, anchorArray[3]);
//			dist1 = vnorm(t3);
//
//			t3 = vdiff(o2, anchorArray[3]);
//			dist2 = vnorm(t3);
//
//			/* find the distance closest to received range measurement from 4th anchor */
//			diff1 = fabs(r4 - dist1);
//			diff2 = fabs(r4 - dist2);
//
//			/* pick the closest match to the 4th anchor range */
//			if (diff1 < diff2) *best_solution = o1; else *best_solution = o2;
//		}
//		else
//		{
//			//assume tag is below the anchors (1, 2, and 3)
//			if (o1.z < p1.z) *best_solution = o1; else *best_solution = o2;
//		}
//	}
//	printf("D	x=%.4f\r\n	y=%.4f\r\n	z=%.4f\r\n	err=%d\r\n", best_solution->x, best_solution->y, best_solution->z, result);
//
//	if (result >= 0)
//	{
//		return result;
//	}
//
//	//return error
//	return -1;
//}
//
//
//
//function calculateTagLocation(vec3d *report , count, distance_struct_t *ranges)
//{
//	var result = 0;
//	vec3d anchorArraay[4];
//	var _distanceArray[4];
//
//	anchorArraay[0].x = ancArray[0].x;
//	anchorArraay[0].y = ancArray[0].y;
//	anchorArraay[0].z = ancArray[0].z;
//
//	anchorArraay[1].x = ancArray[1].x;
//	anchorArraay[1].y = ancArray[1].y;
//	anchorArraay[1].z = ancArray[1].z;
//
//	anchorArraay[2].x = ancArray[2].x;
//	anchorArraay[2].y = ancArray[2].y;
//	anchorArraay[2].z = ancArray[2].z;
//
//	anchorArraay[3].x = ancArray[3].x;
//	anchorArraay[3].y = ancArray[3].y;
//	anchorArraay[3].z = ancArray[3].z;
//
//	_distanceArray[0] = ranges[0].r;
//	_distanceArray[1] = ranges[1].r;
//	_distanceArray[2] = ranges[2].r;
//	_distanceArray[3] = ranges[3].r;
//
//	result = GetLocation(report, ((count == 4) ? 1 : 0), &anchorArray[0], &_distanceArray[0]);
//
//	return result;
//}
//
//









//to calculate the distance from device
function processDistance(rssi, TXPower){
        //1 ALTBeacon
	if(rssi == 0) return -1;
       /* rssi=Math.abs(rssi);
        var ratio = rssi*1.0/TXPower;
	var coefficient1 = 0.42093;
      	var coefficient2 = 6.9476;
      	var coefficient3 = 0.54992;

//		var coefficient1 = 0.9401940951;
//      	var coefficient2 = 6.170094565;
//      	var coefficient3 = 0.0;
//		var coefficient1 = 0.1862616782;
//      	var coefficient2 = 8.235367435;
//      	var coefficient3 = -0.45324519;

        console.log("ratio ",ratio);
        if(ratio < 1.0){ return Math.pow(ratio ,10);}
	else{ return (coefficient1)*Math.pow(ratio, coefficient2)+coefficient3; }
*/
	//2 
	var A = 65;//this value should be the rssi while distance is 1m.
	var n = 3.0;
	var iRssi = Math.abs(rssi);
	var power = (iRssi-A)/(10*n);
	return (Math.pow(10,power)).toFixed(4);


}





function processFallSens(addr, dev, data) {
	var entry = {};
	var fallUpdate = false;
        var distance;
	entry['axis'] = [];
	// data format: flag (1) X Y Z (each 4, IEEE 11073 float LE)
	//console.log('buf ' + data.toString('hex'));
	for (var i = 0; i < 3; i++) {
		var ndata = data.slice(i * 4 + 1, i * 4 + 5);
		var man = ndata.readIntLE(0, 2);
		var exp = ndata.readInt8(3);
		var val = man * Math.pow(10, exp);
		entry['axis'][i] = val;
		if (calibrationTable[addr]) {
			entry['axis'][i] += calibrationTable[addr][i];
		}
	}
	dev['nsample']++;
	dev['humidity'] = 0;
	// Update non-fall event to cloud every 30s (600*50ms)
	if (dev['nsample'] % 600 == 0) {
		fallUpdate = true;
	}
	// Calibration Path
	if (gCalibrate) {
		for (var i = 0; i < 3; i++) {
			dev['calib_axis'][i] += entry['axis'][i];
		}
                distance = processDistance(dev['rssi'],dev['TXPower']);
		console.log('FallSens', addr, 'calibrating', dev['nsample'],
			    //': X =', (0 - dev['calib_axis'][0] / dev['nsample']).toFixed(4),
			    //', Y =', (GRAVITY - dev['calib_axis'][1] / dev['nsample']).toFixed(4),
			    //', Z =', (0 - dev['calib_axis'][2] / dev['nsample']).toFixed(4),
			    ',rssi =', dev['rssi'],
			    ',TXPower =', dev['TXPower'],
                            ',distance =', distance );
		if (dev['nsample'] == CALIBRATE_COUNT) {
			console.log('Calibration Finished. Append below line to calibrationTable:');
			console.log("'" + addr + "' : [",
				    (0 - dev['calib_axis'][0] / dev['nsample']).toFixed(4) + ", ",
				    (GRAVITY - dev['calib_axis'][1] / dev['nsample']).toFixed(4) + ", ",
				    (0 - dev['calib_axis'][2] / dev['nsample']).toFixed(4) + ", ",
				    FALL_THRESHOLD, "],");
			disconnect(function() {
				process.exit(0);
			});
		}
		return false;
	}
	// Fall Detection Path
	var now = new Date().getTime();
	entry['ts'] = now;
	entry['svm'] = Math.sqrt(Math.pow(entry['axis'][0], 2) +
				 Math.pow(entry['axis'][1], 2) +
				 Math.pow(entry['axis'][2], 2));
	//console.log('\t', addr + ' RSSI:' + dev['rssi'], 'FallSens', entry);
	var fallThreshold = FALL_THRESHOLD;
	if (calibrationTable[addr]) {
		fallThreshold = calibrationTable[addr][3];
	}
	if (dev['acc_triggered']) {
		dev['acc_buffer'].push(entry);
	} else if (entry['svm'] >= fallThreshold) {
		dev['acc_triggered'] = true;
		dev['acc_buffer'] = [ entry ];
	}
	if (dev['acc_triggered'] && (now - dev['acc_buffer'][0]['ts'] > 500)) {
		dev['acc_triggered'] = false;
		if (detectFall(addr, dev['acc_buffer'])) {
			dev['humidity'] = 100;
			dev['nsample'] = 0;
			fallUpdate = true;
		}
	}

	return fallUpdate;
}

function processSensorData(addr, data) {
	var dev = gDevices[addr];
	var sensorUpdate = false;
	var logstr = '';
	var sensorMsg = '';

	// Send boot notification on Raspberry Pi
	sendBootNotification();

	if (dev['type'] == TYPE_DIAPERSENS) {
		processDiaperSens(addr, dev, data);
		sensorUpdate = true;
		sensorMsg = 'temperature ' + dev['temperature'] + ' C humidity ' + dev['humidity'] + ' %';
	} else if (dev['type'] == TYPE_FALLSENS) {
		sensorUpdate = processFallSens(addr, dev, data);
		sensorMsg = ', Fall detected: ' + (dev['humidity'] == 0 ? "No" : "Yes");
	}

	if (gConfig['cloudUpdate'] && sensorUpdate) {
		pushAWS(addr, dev['temperature'], dev['humidity'],dev['rssi'] ,dev['TXPower'], function(shadow, err) {
			logstr = ' cloudUpdate ';
			if (err)
				logstr += 'failed';
			else
				logstr += 'success';

			// Ignore shadow result
			if (shadow)
				return;
		});
	}
	if (gConfig['localDBUpdate'] && sensorUpdate) {
		pushLocalDB(addr, dev['temperature'], dev['humidity'], function(err) {
			logstr = ' localDBUpdate';
			if (err)
				logstr += 'failed';
			else
				logstr += 'success';
		});
	}
	if (sensorUpdate) {
		console.log('\t', addr + ' RSSI:' + dev['rssi'], sensorMsg + logstr);
		doNotification(dev);
	}
}

function sendNotification(dev) {
	// Send notification
	var addr = dev['peripheral'].address;
	var subject;
	var body;

	if (dev['type'] == TYPE_DIAPERSENS) {
		subject = 'DiaperSens ' + addr + ' needs your attention';
		body = 'Humidity: ' + dev['humidity'] + ' %\nTemperature: ' +
			dev['temperature'] + ' \u00B0C\n';
	} else if (dev['type'] == TYPE_FALLSENS) {
		subject = 'FallSens ' + addr + ' needs your attention';
		body = 'Fall detected for user ' + addr;
	}

	if (!gConfig['smsNotification'])
		return;

	for (var i in monitorTable[addr]) {
		var phoneInfo = monitorTable[addr][i];
		SendSMS(phoneInfo, subject, body, function(err) {
			if (err) {
				console.log('\t\tSend SMS to ' + this.number +
					' failed: ' + err);
			} else {
				console.log('\t\tSend SMS to ' + this.number +
					' successfully');
			}
		}.bind( {number:phoneInfo['number']} ));
	}
}

function algo_detection(dev) {
	var now = new Date();
	if (dev['state'] == 'STATE_INIT') {
		if (dev['humidity'] >= RH_THRESHOLD) {
			dev['rh_start'] = now;
			dev['state'] = 'STATE_HUMIDITY_DETECTED';
		}
	} else if (dev['state'] == 'STATE_HUMIDITY_DETECTED') {
		if (now.getTime() > new Date(dev['rh_start'].getTime() + ALGO_COOLDOWN_MS).getTime()) {
			dev['records'] = [];
			dev['state'] = 'STATE_TEMP_DETECTING';
		}
	} else if (dev['state'] == 'STATE_TEMP_DETECTING') {
		for (var i in dev['records']) {
			// keep only 1 minutes records
			if (now.getTime() > new Date(dev['records'][i]['timestamp'].getTime() + ALGO_TEMPRAMP_MS).getTime())
				dev['records'].splice(i, 1);
			else
				break;
		}
		var min = Math.min.apply(Math, dev['records'].map(function(r) {
				return r.temperature;
		}));
		if (dev['temperature'] <= min + ALGO_TEMPRAMP_VALUE) {
			dev['records'].push({'timestamp': now,
					     'temperature': dev['temperature'],
					     'humidity': dev['humidity']});
			return;
		}
		// Detected
		if (dev['notified'])
			return;

		// Send notification
		sendNotification(dev);

		dev['state'] = 'STATE_INIT';
		dev['notified'] = false;
		dev['records'] = [];
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
		execFile(cmd, arglist, function(err, stdout, stderr) {
			var output;
			if (err) {
				callback(err, stderr);
				output = err + stderr;
			} else {
				callback(err, stdout);
				output = stdout;
			}
			mqsh.output_pub(os.hostname(), output, function(){});
		});
		break;
	}
}

function bleScan()
{
	if (gState === 'poweredOn' && !gResetting)
		noble.startScanning();
}

function hciReset()
{
	var exec = require('child_process').exec;

	gResetting = true;
	exec('hciconfig hci0 reset', function callback(err, stdout, stderr){
		// result
		//console.log("hci0 reset", err ? "fail" : "success");
		gResetting = false;
	});
}

function pushAWS(addr, vt, vh , rssi , txpower , callback) {
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
		datetime: 	logDate.toISOString(),
		temperature: 	parseFloat(vt),
		humidity: 	parseFloat(vh),
                Rssi:		parseFloat(rssi),
                txPower:	parseFloat(txpower)
	};
	console.log("pushAWS---", postData);
	// publish to main data queue (for DynamoDB)
	execFile('mosquitto_pub', mosqparam.concat('-t', 'temp-humidity/Sensor-' + addr, '-m', JSON.stringify(postData)),
		 function(err, stdout, stderr) {
			// published
			callback(false, err);
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
		 JSON.stringify(shadowPayload)), function(err, stdout, stderr) {
			// shadow update done
			callback(true, err);
	});
}

function pushLocalDB(addr, vt, vh, callback) {
	var con = mysql.createConnection({
		host: gConfig['dbHost'],
		user: "eldersens",
		password: gConfig['dbPasswd'],
		database: "dsdb"
	});
	var sql = `insert into diapersens_tbl(ts, addr, temp, humidity) values(now(), '${addr}', ${vt}, ${vh})`;
	console.log("pushLocalDB:", sql);
	con.query(sql, function(err, result) {
		callback(err);
		con.end();
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
		if (gConfig['cloudUpdate']) {
			pushAWS(addr, temp, humidity, function(shadow, err) {
				if (err)
					console.log("AWS push error,", err, "shadow:", shadow);
			});
		}
		if (gConfig['localDBUpdate']) {
			pushLocalDB(addr, temp, humidity, function(err) {
				if (err)
					console.log("MySQL push error,", err);
			});
		}
		simDevice['temperature'] = temp;
		simDevice['humidity'] = humidity;
		doNotification(simDevice);
	}, 5000);
}


// Program starts here
if ((process.argv.length > 2) && (process.argv[2].toLowerCase() == 'calibrate')) {
	gCalibrate = true;
	if (process.argv[3])
		gCalibrateDevice = process.argv[3].toLowerCase();
}

noble.on('stateChange', function(state) {
	gState = state;
	if (state === 'poweredOn') {
		noble.startScanning();
	} else {
		noble.stopScanning();
	}
});

noble.on('discover', function(peripheral) {
	//console.log("noble.on discover. "+peripheral.advertisement.localName);
	if(peripheral.advertisement.localName == "CFX_FALLS"){
	//if (peripheral.advertisement.localName == "CFX_FALLSENS" ||
	//    (peripheral.advertisement.localName == "XuXuKou" && !gCalibrate)) {
		var addr = peripheral.address;
		var now = (new Date()).getTime();
                console.log("find CFX_FALLSENS.");
		if (gCalibrate) {
			// Use the first found device if calibrate device is unspecified
			if (!gCalibrateDevice)
				gCalibrateDevice = addr;

			// Only allow one device per calibration
			if (addr != gCalibrateDevice)
				return;
		}

		// Avoid duplicated connection, parallel connection and if we haven't heard a sensor
		// for 20s, we will reconnect with it (when adv is heard).
		if (gDevices[addr] && (now - gDevices[addr]['tsconn'] < 20 * 1000) &&
		    (gDevices[addr]['enabled'] == true || gDevices[addr]['connecting'] == true)) {
			//console.log("Quit connection: addr ", addr, "enable", gDevices[addr]['enabled'],
			//	    "connecting", gDevices[addr]['connecting'], "tsdiff", now - gDevices[addr]['tsconn']);
			//hciReset();
			return;
		}
		if (!gDevices[addr])
			gDevices[addr] = new Device(peripheral);

		if (peripheral.advertisement.localName == "XuXuKou") {
			if (!gDevices[addr]['firstadv'])
				gDevices[addr]['firstadv'] = now;
			if (now - gDevices[addr]['firstadv'] < 10 * 1000)
				return;
		}

		// start connection
		gDevices[addr]['connecting'] = true;
		gDevices[addr]['tsconn'] = now;
		peripheral.connect(function(err) {
			if (err) {
				console.log('Connect', addr, err);
				return;
			}
			gDevices[addr]['firstadv'] = 0;
			console.log('Connected to ' + peripheral.address + ' (RSSI ' + peripheral.rssi + ') on ' + new Date());
			peripheral.discoverServices(['1809', '6e400001b5a3f393e0a9e50e24dcca9e'], function(err, services) {
				var deviceInformationService = services[0];
				console.log("Discovered Health Thermometer GATT Service");
				deviceInformationService.discoverCharacteristics(['2a1c', '6e400003b5a3f393e0a9e50e24dcca9e'], function(err, characteristics) {
					var temperatureMeasurementCharacteristic = characteristics[0];
					console.log('Discovered Temperature Measurement Service');
					// enable notify
					temperatureMeasurementCharacteristic.notify(true, function(err) {
						console.log('Temperature Measurement Notification On');
						gDevices[addr]['enabled'] = true;
						gDevices[addr]['connecting'] = false;
						gDevices[addr]['tsconn'] = now;
					});
					// subscribe indicate
					temperatureMeasurementCharacteristic.subscribe(function(err) {
						temperatureMeasurementCharacteristic.on('data', function(data, isNotification) {
							switch (temperatureMeasurementCharacteristic.uuid) {
							case '2a1c':
								gDevices[addr]['type'] = TYPE_FALLSENS;
								break;
							case '6e400003b5a3f393e0a9e50e24dcca9e':
							default:
								gDevices[addr]['type'] = TYPE_DIAPERSENS;
								break;
							}
							processSensorData(addr, data);
						});
					});
				});
			});
			// handle disconnect event
			peripheral.once('disconnect', function() {
				var address = peripheral.address;
				if (gDevices[address] == undefined)
					bleScan();
				else if (gDevices[address]['enabled']) {
					console.log(address + ' (RSSI: ' + gDevices[address]['rssi'] + ') disconnected on ' + new Date());
					gDevices[address]['enabled'] = false;
					gDevices[address]['connecting'] = false;
					bleScan();
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
		service: 'Gmail',
		auth: {
			type: 'login',
			user: 'chuangfeixin',
			pass: 'www.chuangfeixin.com'
		},
		debug: false // include SMTP traffic in the logs
	}, {
		// default message fields
		// sender info
		from: 'CFX <chuangfeixin@gmail.com>',
	});

	// Message object
	let message = {
		to: recipient,
		subject: subject,
		text: body,
		html: "<b>" + body + "</b>"
	}

	transporter.sendMail(message, (err, info) => {
		if (err) {
			console.log(err);
			callback(err);
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
		'Verizon': 'vtext.com'};
	var carrier = phoneInfo['carrier'];
	var number = phoneInfo['number'];

	if (gateways[carrier] == undefined) {
		cb("invalid carrier " + carrier);
		return;
	}
	// normalize U.S. phone number
	if (number[0] == '+')
		number = number.substring(1);
	if (number[0] == '1')
		number = number.substring(1);

	if (number.length != 10) {
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
			peripheral.updateRssi(function(err, rssi) {
				if (!err) {
					gDevices[addr]['rssi'] = rssi;
				}
			});
		// if the connecting state stuck for 30s
		} else if (gDevices[addr]['connecting'] && ((new Date()).getTime() - gDevices[addr]['tsconn'] > 30 * 1000)) {
			gDevices[addr]['peripheral'].disconnect(function() {
				//console.log("disconnect", addr, "after no activity for 30s");
			});
		}
	}
	bleScan();
}, 1000);

// handle MQTT management
mqsh.input_sub(os.hostname(), function(sub) {
	sub.stdout.on('data', (data) => {
		execCmd(data.toString(), function(err, output) {
			//if (err)
			//	console.log(err);
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
