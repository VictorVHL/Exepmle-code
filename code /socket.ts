import { createServer } from "http";
import { Server } from "socket.io"
import jwt_decode from "jwt-decode";
import axios from "axios";
import moment from "moment";
import { CustomerAccessToken, AccessToken, CustomersNetworkManager} from "@cherrypie/feedc.common";
import { deleteSocket, findSocketConnections, saveSocket } from "./Seocket";
import { app } from "..";
import { RealtimenotificationManager } from "./RealTimeNotification";

const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: ["https://feedc.com", "http://localhost:3000"],
        credentials: true
    }
});
  
export class SocketIO {

    async listenSocket() {
        let decode_token: any;
        let token: string;
        let customerId: string;
        let properties: any;
        const newTimestamp = moment().subtract().unix()
        const pageId = 1;

        
        io.on("connection", async (socket: any) => {

            if (socket.handshake.auth.token) {
                token = socket.handshake.auth.token;
            }
            decode_token = jwt_decode(token!);

            if (decode_token.accessToken) {
                customerId = decode_token.accessToken.customerId;
            }
            console.log('client_conected')
            const timestamp = new Date().valueOf();
            io.to(socket.id).emit('ping', { response:`ping ${timestamp}` });

            saveSocket(socket.id, { customerId });

            socket.on("disconnect", async () => {
                deleteSocket(socket.id);

                console.log('client_disconected', 'pageId: ', pageId, 'customerId: ', customerId, 'token: ', token);

                const customer = await CustomersNetworkManager.getCustomer(pageId, customerId, token, true);

                console.log('client_disconected', 'customer: ', customer);


                if (customer){
                    properties = customer.properties;
        
                    const found = properties.some((item: any) => item.id === 22);
                    if (found) {
                        properties.map(async (property: any) => {
                            if (property.id == 22) {
                                property.value = newTimestamp;
                            }
                        })
                    }
                    else {
                        properties.push({ id: 22, value: newTimestamp });
                    }
                    await this.updateCustomer(token, customerId, properties);
                }
            })
        });

        httpServer.listen(process.env.PORT, () => console.log(`Socket listening on port ${process.env.PORT}`));
    }

    async updateCustomer(token: string, customerId: string, properties: object) {
        const response = await axios({
            url: `${process.env.CUSTOMERS_MICROSERVICE_ENDPOINT}/pages/1/customers/${customerId}`,
            method: "put",
            headers: {
                Authorization: `Bearer ${token}`,
            },
            data: { properties: properties }
        }).then(data => {
            return data;
        }).catch(error => {
            return error;
        });
        return response;
    }

    async sendNotificationToCustomer() {
        const RealTimeManager = new RealtimenotificationManager();
        const notifications = await RealTimeManager.getRealTimeNotificationsAndDelete();

        const sockets = findSocketConnections()

        sockets.forEach((socket: any) => {
            for (let object of notifications) {
                if (socket.customerId == object.customerId) {
                    io.to(socket.socketId).emit('notification', { response: object.data });
                }
            }
        })
    }
}