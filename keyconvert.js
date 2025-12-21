const fs = require('fs');
const key = fs.readFileSync('./assetverse-2121-firebase-adminsdk-fbsvc-aa77e9767d.json', 'utf8')
const base64 = Buffer.from(key).toString('base64')
console.log(base64)