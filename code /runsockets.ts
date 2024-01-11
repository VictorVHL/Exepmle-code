import express from 'express';
import 'express-async-errors';
import { json } from 'body-parser';
import 'reflect-metadata';
import cors from 'cors';
import {createConnection} from 'typeorm';
import mongoose from 'mongoose';

import './services/Secrets'

import { errorHandler, NotFoundError } from '@cherrypie/feedc.common'

import { SocketIO } from './services/SocketIo';
import { runSockets } from './services/runRealTimeNotifications';

export const app = express();
app.use(json());
app.use(cors());

app.all('*', async () => {
    throw new NotFoundError();
});

app.use(errorHandler);

const start = async () => {
    const connection = await createConnection();
    console.log('Connected to db!');

    await mongoose.connect(process.env.MONGODB_CONNECTION_URL!, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
        useFindAndModify: false,
        useCreateIndex: true,
    });
    console.log('Connected to mongodb!');

    const port = (process.env.SOCKET_ENABLE! === 'true') ? process.env.SOCKET_PORT : process.env.PORT;
    app.listen(port, () => {
        console.log(`Listening on port ${port}.`);
    });

    if(process.env.SOCKET_ENABLE! === 'true') {
        const socketIO = new SocketIO();
        await socketIO.listenSocket();

        console.log('send notifications to client!');
        runSockets()
    }
}

start();