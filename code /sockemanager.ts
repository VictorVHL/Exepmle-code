const conections: any =  {};

export const saveSocket = (socketId: any, data: any = {}) => {
    conections[socketId] = {...data, socketId}
}

export const findSocketConnections = () => {
    return Object.values(conections);
}

export const deleteSocket = (id: any) => {
    delete conections[id]
}