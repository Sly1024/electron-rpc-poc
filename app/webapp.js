api.receive('channel', (evt, msg) => console.log('received', msg));
api.send('channel', { a: 1 });
