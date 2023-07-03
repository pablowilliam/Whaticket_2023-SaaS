import { writeFileSync } from "fs";
import axios from "axios";
import { join } from "path";
import Contact from "../../models/Contact";
import Ticket from "../../models/Ticket";
import CreateOrUpdateContactService from "../ContactServices/CreateOrUpdateContactService";
import CreateMessageService from "../MessageServices/CreateMessageService";
import FindOrCreateTicketService from "../TicketServices/FindOrCreateTicketService";
import { getProfile, profilePsid, sendText } from "./graphAPI";
import Whatsapp from "../../models/Whatsapp";
import UpdateTicketService from "../TicketServices/UpdateTicketService";
import { debounce } from "../../helpers/Debounce";
import ShowWhatsAppService from "../WhatsappService/ShowWhatsAppService";
import formatBody from "../../helpers/Mustache";
import Queue from "../../models/Queue";
import Message from "../../models/Message";
import FindOrCreateTicketServiceMeta from "../TicketServices/FindOrCreateTicketServiceMeta";
import {  isNumeric, sleep, validaCpfCnpj, verifyRating } from "../WbotServices/wbotMessageListener";
import moment from "moment";
import UserRating from "../../models/UserRating";
import { isNil, isNull, head } from "lodash";
import TicketTraking from "../../models/TicketTraking";
import { getIO } from "../../libs/socket";
import FindOrCreateATicketTrakingService from "../TicketServices/FindOrCreateATicketTrakingService";
import puppeteer from "puppeteer";
import Setting from "../../models/Setting";

import  { sendFacebookMessageFileExternal, sendFacebookMessageMediaExternal } from "../FacebookServices/sendFacebookMessageMedia";
import sendFaceMessage from "../FacebookServices/sendFacebookMessage";

import fs from "fs";
import QueueOption from "../../models/QueueOption";

interface IMe {
  name: string;
  // eslint-disable-next-line camelcase
  first_name: string;
  // eslint-disable-next-line camelcase
  last_name: string;
  // eslint-disable-next-line camelcase
  profile_pic: string;
  id: string;
}

export interface Entry {
  id: string;
  time: number;
  messaging: Messaging[];
}

export interface Root {
  object: string;
  entry: Entry[];
}

export interface Sender {
  id: string;
}

export interface Recipient {
  id: string;
}

export interface MessageX {
  mid: string;
  text: string;
  reply_to: ReplyTo;
}

export interface Messaging {
  sender: Sender;
  recipient: Recipient;
  timestamp: number;
  message: MessageX;
}
export interface ReplyTo {
  mid: string;
}

const verifyContact = async (msgContact: any, companyId: number, channel = "whatsapp") => {
  if (!msgContact) return null;

  const contactData = {
    name:
      msgContact?.name || `${msgContact?.first_name} ${msgContact?.last_name}`,
    number: msgContact.id,
    profilePicUrl: "",
    isGroup: false,
    companyId,
    channel
  };

  const contact = CreateOrUpdateContactService(contactData);

  return contact;
};

const verifyQuotedMessage = async (msg: any): Promise<Message | null> => {
  if (!msg) return null;
  const quoted = msg?.reply_to?.mid;

  if (!quoted) return null;

  const quotedMsg = await Message.findOne({
    where: { id: quoted }
  });

  if (!quotedMsg) return null;

  return quotedMsg;
};

export const verifyMessage = async (
  msg: any,
  body: any,
  ticket: Ticket,
  contact: Contact,
  companyId: number,
  channel: string,
) => {
  const quotedMsg = await verifyQuotedMessage(msg);
  const messageData = {
    id: msg.mid || msg.message_id,
    ticketId: ticket.id,
    contactId: msg.is_echo ? undefined : contact.id,
    body: msg.text || body,
    fromMe: msg.is_echo,
    read: msg?.is_echo,
    quotedMsgId: quotedMsg?.id,
    ack: 3,
    dataJson: JSON.stringify(msg),
    channel: channel
  };

  console.log(msg);
  await CreateMessageService({ messageData, companyId });

  await ticket.update({
    lastMessage: msg.text
  });
};

export const verifyMessageMedia = async (
  msg: any,
  ticket: Ticket,
  contact: Contact,
  companyId: number,
  channel: string,
): Promise<void> => {
  const { data } = await axios.get(msg.attachments[0].payload.url, {
    responseType: "arraybuffer"
  });

  // eslint-disable-next-line no-eval
  const { fileTypeFromBuffer } = await (eval('import("file-type")') as Promise<
    typeof import("file-type")
  >);

  const type = await fileTypeFromBuffer(data);

  const fileName = `${new Date().getTime()}.${type.ext}`;

  writeFileSync(
    join(__dirname, "..", "..", "..", "public", fileName),
    data,
    "base64"
  );

  const messageData = {
    id: msg.mid,
    ticketId: ticket.id,
    contactId: msg.is_echo ? undefined : contact.id,
    body: msg?.text || fileName,
    fromMe: msg.is_echo,
    mediaType: msg.attachments[0].type,
    mediaUrl: fileName,
    read: msg.is_echo,
    quotedMsgId: null,
    ack: 3,
    dataJson: JSON.stringify(msg),
    channel: channel
  };

  await CreateMessageService({ messageData, companyId: companyId });

  await ticket.update({
    lastMessage: msg?.text || fileName,
  });
};

export const handleRating = async (
  msg: any,
  ticket: Ticket,
  ticketTraking: TicketTraking
) => {
  const io = getIO();
  let rate: number | null = null;

  if (msg.message?.conversation) {
    rate = +msg.message?.conversation;
  }

  if (!Number.isNaN(rate) && Number.isInteger(rate) && !isNull(rate)) {
    const { complationMessage } = await ShowWhatsAppService(
      ticket.whatsappId,
      ticket.companyId
    );

    let finalRate = rate;

    if (rate < 1) {
      finalRate = 1;
    }
    if (rate > 3) {
      finalRate = 3;
    }

    await UserRating.create({
      ticketId: ticketTraking.ticketId,
      companyId: ticketTraking.companyId,
      userId: ticketTraking.userId,
      rate: finalRate,
    });
    const body = formatBody(`\u200e${complationMessage}`, ticket.contact);
    // await SendWhatsAppMessage({ body, ticket });

    await ticketTraking.update({
      finishedAt: moment().toDate(),
      rated: true,
    });

    await ticket.update({
      queueId: null,
      userId: null,
      status: "closed",
    });

    io.to("open").emit(`company-${ticket.companyId}-ticket`, {
      action: "delete",
      ticket,
      ticketId: ticket.id,
    });

    io.to(ticket.status)
      .to(ticket.id.toString())
      .emit(`company-${ticket.companyId}-ticket`, {
        action: "update",
        ticket,
        ticketId: ticket.id,
      });

  }

};

const sendMessageImage = async (
  contact,
  ticket: Ticket,
  url: string,
  caption: string
) => {

  let sentMessage
  try {

    sentMessage = await sendFacebookMessageMediaExternal({
      url,
      ticket,
    })

  } catch (error) {
    await sendFaceMessage({
      ticket,
      body: formatBody('Não consegui enviar o PDF, tente novamente!', contact)
    })
  }
  // verifyMessage(sentMessage, ticket, contact);
};

const verifyQueue = async (
  wbot: any,
  message: string,
  ticket: Ticket,
  contact: Contact
) => {
  const { queues, greetingMessage } = await ShowWhatsAppService(
    wbot.id!,
    ticket.companyId
  );
  if (queues?.length === 1) {
    const firstQueue = head(queues);
    let chatbot = false;
    if (firstQueue?.options) {
      chatbot = firstQueue?.options?.length > 0;
    }
    await UpdateTicketService({
      ticketData: { queueId: firstQueue?.id, chatbot },
      ticketId: ticket.id,
      companyId: ticket.companyId,
    });

    return;
  }

  const selectedOption = message;
  const choosenQueue = queues[+selectedOption - 1];

  const companyId = ticket.companyId;

  const botText = async () => {
    let options = "";

    queues.forEach((queue, index) => {
      options += `*[ ${index + 1} ]* - ${queue.name}\n`;
    });


    const textMessage = formatBody(`\u200e${greetingMessage}\n\n${options}`, contact)

    await sendFaceMessage({
      ticket,
      body: textMessage
    })

    // const sendMsg = await wbot.sendMessage(
    //   `${contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`,
    //   textMessage
    // );

    // await verifyMessage(sendMsg, ticket, ticket.contact);
  };

  if (choosenQueue) {
    let chatbot = false;
    if (choosenQueue?.options) {
      chatbot = choosenQueue?.options?.length > 0;
    }
    await UpdateTicketService({
      ticketData: { queueId: choosenQueue.id, chatbot },
      ticketId: ticket.id,
      companyId: ticket.companyId,
    });


    /* Tratamento para envio de mensagem quando a fila está fora do expediente */
    if (choosenQueue?.options?.length === 0) {
      const queue = await Queue.findByPk(choosenQueue.id);
      const { schedules }: any = queue;
      const now = moment();
      const weekday = now.format("dddd").toLowerCase();
      let schedule;
      if (Array.isArray(schedules) && schedules?.length > 0) {
        schedule = schedules.find((s) => s.weekdayEn === weekday && s.startTime !== "" && s.startTime !== null && s.endTime !== "" && s.endTime !== null);
      }

      if (queue.outOfHoursMessage !== null && queue.outOfHoursMessage !== "" && !isNil(schedule)) {
        const startTime = moment(schedule.startTime, "HH:mm");
        const endTime = moment(schedule.endTime, "HH:mm");

        if (now.isBefore(startTime) || now.isAfter(endTime)) {
          const body = formatBody(`${queue.outOfHoursMessage}\n\n*[ # ]* - Voltar ao Menu Principal`, ticket.contact);

          const sentMessage = await sendFaceMessage({
            ticket,
            body: body
          })

          // const sentMessage = await wbot.sendMessage(
          //   `${contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, {
          //   text: body,
          // }
          // );
          // await verifyMessage(sentMessage, ticket, contact);
          await UpdateTicketService({
            ticketData: { queueId: null, chatbot },
            ticketId: ticket.id,
            companyId: ticket.companyId,
          });
          return;
        }
      }

      const body = formatBody(`\u200e${choosenQueue.greetingMessage}`, ticket.contact
      );
      const sentMessage = await sendFaceMessage({
        ticket,
        body: body
      })
      // await verifyMessage(sentMessage, ticket, contact);
    }

  } else {
    await botText();

  }

};

const handleChartbot = async (ticket: Ticket, msg: string, wbot: any, dontReadTheFirstQuestion: boolean = false) => {

  const queue = await Queue.findByPk(ticket.queueId, {
    include: [
      {
        model: QueueOption,
        as: "options",
        where: { parentId: null },
        order: [
          ["option", "ASC"],
          ["createdAt", "ASC"],
        ],
      },
    ],
  });
  if (ticket.queue !== null) {
    const queue = await Queue.findByPk(ticket.queueId);
    const { schedules }: any = queue;
    const now = moment();
    const weekday = now.format("dddd").toLowerCase();
    let schedule;

    if (Array.isArray(schedules) && schedules?.length > 0) {
      schedule = schedules.find((s) => s.weekdayEn === weekday && s.startTime !== "" && s.startTime !== null && s.endTime !== "" && s.endTime !== null);
    }

    if (ticket.queue.outOfHoursMessage !== null && ticket.queue.outOfHoursMessage !== "" && !isNil(schedule)) {
  
      const startTime = moment(schedule.startTime, "HH:mm");
      const endTime = moment(schedule.endTime, "HH:mm");

      if (now.isBefore(startTime) || now.isAfter(endTime)) {
        const body = formatBody(`${ticket.queue.outOfHoursMessage}\n\n*[ # ]* - Voltar ao Menu Principal`, ticket.contact);
        
   

        await sendFaceMessage({
          ticket,
          body: body
        })
        // await verifyMessage(sentMessage, ticket, ticket.contact);
        return;
      }


      const body = formatBody(`\u200e${ticket.queue.greetingMessage}`, ticket.contact
      );
      // const sentMessage = await wbot.sendMessage(
      //   `${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, {
      //   text: body,
      // }
      // );

      await sendFaceMessage({
        ticket,
        body: body
      })
      // await verifyMessage(sentMessage, ticket, ticket.contact);
    }
  }


  const messageBody = msg

  if (messageBody == "#") {
    // voltar para o menu inicial
    await ticket.update({ queueOptionId: null, chatbot: false, queueId: null });
    await verifyQueue(wbot, msg, ticket, ticket.contact);
    return;
  }

  // voltar para o menu anterior
  if (!isNil(queue) && !isNil(ticket.queueOptionId) && messageBody == "#") {
    const option = await QueueOption.findByPk(ticket.queueOptionId);
    await ticket.update({ queueOptionId: option?.parentId });

    // escolheu uma opção
  } else if (!isNil(queue) && !isNil(ticket.queueOptionId)) {
    const count = await QueueOption.count({
      where: { parentId: ticket.queueOptionId },
    });
    let option: any = {};
    if (count == 1) {
      option = await QueueOption.findOne({
        where: { parentId: ticket.queueOptionId },
      });
    } else {
      option = await QueueOption.findOne({
        where: {
          option: messageBody || "",
          parentId: ticket.queueOptionId,
        },
      });
    }
    if (option) {
      await ticket.update({ queueOptionId: option?.id });
    }

    // não linha a primeira pergunta
  } else if (!isNil(queue) && isNil(ticket.queueOptionId) && !dontReadTheFirstQuestion) {
    const option = queue?.options.find((o) => o.option == messageBody);
    if (option) {
      await ticket.update({ queueOptionId: option?.id });
    }
  }

  await ticket.reload();

  if (!isNil(queue) && isNil(ticket.queueOptionId)) {

    const queueOptions = await QueueOption.findAll({
      where: { queueId: ticket.queueId, parentId: null },
      order: [
        ["option", "ASC"],
        ["createdAt", "ASC"],
      ],
    });

    const companyId = ticket.companyId;


    const botText = async () => {
      let options = "";

      queueOptions.forEach((option, i) => {
        options += `*[ ${option.option} ]* - ${option.title}\n`;
      });
      options += `\n*[ # ]* - Voltar Menu Inicial`;

      const textMessage = formatBody(`\u200e${queue.greetingMessage}\n\n${options}`, ticket.contact)

      // const sendMsg = await wbot.sendMessage(
      //   `${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`,
      //   textMessage
      // );

      await sendFaceMessage({
        ticket,
        body: textMessage
      })

      // await verifyMessage(sendMsg, ticket, ticket.contact);
    };
    return botText();

  } else if (!isNil(queue) && !isNil(ticket.queueOptionId)) {
    const currentOption = await QueueOption.findByPk(ticket.queueOptionId);
    const queueOptions = await QueueOption.findAll({
      where: { parentId: ticket.queueOptionId },
      order: [
        ["option", "ASC"],
        ["createdAt", "ASC"],
      ],
    });

    if (queueOptions?.length > 1) {


      const botText = async () => {

        let options = "";

        queueOptions.forEach((option, i) => {
          options += `*[ ${option.option} ]* - ${option.title}\n`;
        });
        options += `\n*[ # ]* - Voltar Menu Inicial`;

 
        await sendFaceMessage({
          ticket,
          body: formatBody(`\u200e${currentOption.message}\n\n${options}`, ticket.contact)
        })

      };

      return botText();

    }
  }
}

const sendMessageLink = async (
  ticket: Ticket,
  url: string,
) => {
  await sendFacebookMessageFileExternal({
    url,
    ticket,
  })
  // verifyMessage(sentMessage, ticket, contact);
};

export const handleMessage = async (
  token: Whatsapp,
  webhookEvent: any,
  channel: string,
  companyId: number
): Promise<any> => {

  console.log(webhookEvent);


  if (webhookEvent.message) { 
    let msgContact: any;

    const senderPsid = webhookEvent.sender.id;
    const recipientPsid = webhookEvent.recipient.id;
    const { message } = webhookEvent;
    const fromMe = message.is_echo;


    if (fromMe) {
      // if (/\u200e/.test(message.text)) return;
      msgContact = await profilePsid(recipientPsid, token.facebookUserToken);
    } else {
      msgContact = await profilePsid(senderPsid, token.facebookUserToken);
    }

    const contact = await verifyContact(msgContact,companyId, channel);

    const unreadCount = fromMe ? 0 : 1;

    const getSession = await Whatsapp.findOne({
      where: {
        facebookPageUserId: token.facebookPageUserId
      }
    });

    if (
      getSession.farewellMessage &&
      formatBody(getSession.farewellMessage, contact) === message.text
    )
      return;

      const ticket = await FindOrCreateTicketServiceMeta(
        contact,
        getSession.id,
        unreadCount,
        companyId,
        channel
      )

      if (message.attachments) {
        await verifyMessageMedia(message, ticket, contact, companyId, channel);
      }

      await verifyMessage(message, message.text, ticket, contact, companyId, channel);

      
    /////INTEGRAÇÕES
    // const filaescolhida = ticket.queue?.name
    // if (filaescolhida === "2ª Via de Boleto" || filaescolhida === "2 Via de Boleto") {
    //   let cpfcnpj
    //   cpfcnpj = message;
    //   cpfcnpj = cpfcnpj.replace(/\./g, '');
    //   cpfcnpj = cpfcnpj.replace('-', '')
    //   cpfcnpj = cpfcnpj.replace('/', '')
    //   cpfcnpj = cpfcnpj.replace(' ', '')
    //   cpfcnpj = cpfcnpj.replace(',', '')

    //   const asaastoken = await Setting.findOne({
    //     where: {
    //       key: "asaas",
    //       companyId
    //     }
    //   });
    //   const ixcapikey = await Setting.findOne({
    //     where: {
    //       key: "tokenixc",
    //       companyId
    //     }
    //   });
    //   const urlixcdb = await Setting.findOne({
    //     where: {
    //       key: "ipixc",
    //       companyId
    //     }
    //   });
    //   const ipmkauth = await Setting.findOne({
    //     where: {
    //       key: "ipmkauth",
    //       companyId
    //     }
    //   });
    //   const clientidmkauth = await Setting.findOne({
    //     where: {
    //       key: "clientidmkauth",
    //       companyId
    //     }
    //   });
    //   const clientesecretmkauth = await Setting.findOne({
    //     where: {
    //       key: "clientsecretmkauth",
    //       companyId
    //     }
    //   });

    //   let urlmkauth = ipmkauth.value
    //   if (urlmkauth.substr(-1) === '/') {
    //     urlmkauth = urlmkauth.slice(0, -1);
    //   }

    //   //VARS
    //   let url = `${urlmkauth}/api/`;
    //   const Client_Id = clientidmkauth.value
    //   const Client_Secret = clientesecretmkauth.value
    //   const ixckeybase64 = btoa(ixcapikey.value);
    //   const urlixc = urlixcdb.value
    //   const asaastk = asaastoken.value

    //   const cnpj_cpf = message
    //   let numberCPFCNPJ = cpfcnpj;

    //   if (urlmkauth != "" && Client_Id != "" && Client_Secret != "") {
    //     if (isNumeric(numberCPFCNPJ) === true) {
    //       if (cpfcnpj.length > 2) {
    //         const isCPFCNPJ = validaCpfCnpj(numberCPFCNPJ)
    //         if (isCPFCNPJ) {
    //           try {
    //             await sleep(2000)
    //             await sendFaceMessage({ body: formatBody(`Aguarde! Estamos consultando na base de dados!`, contact), ticket });

    //           } catch (error) {
    //             //console.log('Não consegui enviar a mensagem!')
    //           }

    //           axios({
    //             // rejectUnauthorized: true,
    //             method: 'get',
    //             url,
    //             auth: {
    //               username: Client_Id,
    //               password: Client_Secret
    //             }
    //           })
    //             .then(function (response) {
    //               const jtw = response.data
    //               var config = {
    //                 method: 'GET',
    //                 url: `${urlmkauth}/api/cliente/show/${numberCPFCNPJ}`,
    //                 headers: {
    //                   Authorization: `Bearer ${jtw}`
    //                 }
    //               };
    //               axios.request(config as any)
    //                 .then(async function (response) {
    //                   if (response.data == 'NULL') {
    //                     const textMessage = {
    //                       text: formatBody(`Cadastro não localizado! *CPF/CNPJ* incorreto ou inválido. Tenta novamente!`, contact),
    //                     };
    //                     try {
    //                       await sleep(2000)

    //                       await sendFaceMessage({ body: formatBody(`Cadastro não localizado! *CPF/CNPJ* incorreto ou inválido. Tenta novamente!`, contact), ticket });

    //                     } catch (error) {
    //                       console.log('Não consegui enviar a mensagem!')
    //                     }
    //                   } else {
    //                     let nome
    //                     let cpf_cnpj
    //                     let qrcode
    //                     let valor
    //                     let bloqueado
    //                     let linhadig
    //                     let uuid_cliente
    //                     let referencia
    //                     let status
    //                     let datavenc
    //                     let descricao
    //                     let titulo
    //                     let statusCorrigido
    //                     let valorCorrigido

    //                     nome = response.data.dados_cliente.titulos.nome
    //                     cpf_cnpj = response.data.dados_cliente.titulos.cpf_cnpj
    //                     valor = response.data.dados_cliente.titulos.valor
    //                     bloqueado = response.data.dados_cliente.titulos.bloqueado
    //                     uuid_cliente = response.data.dados_cliente.titulos.uuid_cliente
    //                     qrcode = response.data.dados_cliente.titulos.qrcode
    //                     linhadig = response.data.dados_cliente.titulos.linhadig
    //                     referencia = response.data.dados_cliente.titulos.referencia
    //                     status = response.data.dados_cliente.titulos.status
    //                     datavenc = response.data.dados_cliente.titulos.datavenc
    //                     descricao = response.data.dados_cliente.titulos.descricao
    //                     titulo = response.data.dados_cliente.titulos.titulo
    //                     statusCorrigido = status[0].toUpperCase() + status.substr(1);
    //                     valorCorrigido = valor.replace(".", ",");

    //                     var curdate = new Date(datavenc)
    //                     const mesCorreto = curdate.getMonth() + 1
    //                     const ano = ('0' + curdate.getFullYear()).slice(-4)
    //                     const mes = ('0' + mesCorreto).slice(-2)
    //                     const dia = ('0' + curdate.getDate()).slice(-2)
    //                     const anoMesDia = `${dia}/${mes}/${ano}`

    //                     try {
    //                       const textMessage = formatBody(`Localizei seu Cadastro! *${nome}* só mais um instante por favor!`, contact)
    //                       // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, textMessage);
    //                       await sendFaceMessage({ body: textMessage, ticket });

                         
    //                       const bodyBoleto = formatBody(`Segue a segunda-via da sua Fatura!\n\n*Nome:* ${nome}\n*Valor:* R$ ${valorCorrigido}\n*Data Vencimento:* ${anoMesDia}\n*Link:* ${urlmkauth}/boleto/21boleto.php?titulo=${titulo}\n\nVou mandar o *código de barras* na próxima mensagem para ficar mais fácil para você copiar!`, contact)
    //                       await sleep(2000)
    //                       await sendFaceMessage({ body: bodyBoleto, ticket });

    //                      // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyBoleto);
    //                       const bodyLinha = formatBody(`${linhadig}`, contact)
    //                       await sleep(2000)
    //                       await sendFaceMessage({ body: bodyLinha, ticket });
    //                       // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyLinha);
    //                       if (qrcode !== null) {
    //                         const bodyPdf = formatBody(`Este é o *PIX COPIA E COLA*`, contact)
    //                         await sleep(2000)
    //                         await sendFaceMessage({ body: bodyPdf, ticket });

    //                         // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyPdf);
    //                         const bodyqrcode = formatBody(`${qrcode}`, contact)
    //                         await sleep(2000)
    //                         // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyqrcode);
    //                         await sendFaceMessage({ body: bodyqrcode, ticket });

    //                         let linkBoleto = `https://chart.googleapis.com/chart?cht=qr&chs=500x500&chld=L|0&chl=${qrcode}`
    //                         await sleep(2000)
    //                         await sendMessageImage(contact, ticket, linkBoleto, "")
    //                       }
    //                       const bodyPdf =formatBody(`Agora vou te enviar o boleto em *PDF* caso você precise.`, contact)
    //                       await sleep(2000)
    //                       const bodyPdfQr = { text: formatBody(`${bodyPdf}`, contact) };
    //                       // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyPdfQr);

    //                       await sendFaceMessage({ body: bodyPdf, ticket });

    //                       await sleep(2000)

    //                       //GERA O PDF                                    
    //                       const nomePDF = `Boleto-${nome}-${dia}-${mes}-${ano}.pdf`;
    //                       (async () => {
    //                         const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
    //                         const page = await browser.newPage();
    //                         const website_url = `${urlmkauth}/boleto/21boleto.php?titulo=${titulo}`;
    //                         await page.goto(website_url, { waitUntil: 'networkidle0' });
    //                         await page.emulateMediaType('screen');
    //                         // Downlaod the PDF
    //                         const pdf = await page.pdf({
    //                           path: nomePDF,
    //                           printBackground: true,
    //                           format: 'A4',
    //                         });

    //                         await browser.close();
    //                         await sendMessageLink( ticket, nomePDF);
    //                       });


    //                       if (bloqueado === 'sim') {
    //                         const bodyBloqueio = formatBody(`${nome} vi tambem que a sua conexão esta bloqueada! Vou desbloquear para você por *48 horas*.`, contact)
    //                         await sleep(2000)
    //                         // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyBloqueio);
    //                         await sendFaceMessage({ body: bodyPdf, ticket });

    //                         const bodyqrcode = formatBody(`Estou liberando seu acesso. Por favor aguarde!`, contact)
    //                         await sleep(2000)
    //                         // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyqrcode);
    //                         await sendFaceMessage({ body: bodyqrcode, ticket });

    //                         var optionsdesbloq = {
    //                           method: 'GET',
    //                           url: `${urlmkauth}/api/cliente/desbloqueio/${uuid_cliente}`,
    //                           headers: {
    //                             Authorization: `Bearer ${jtw}`
    //                           }
    //                         };
    //                         axios.request(optionsdesbloq as any).then(async function (response) {
    //                           const bodyLiberado = formatBody(`Pronto liberei! Vou precisar que você *retire* seu equipamento da tomada.\n\n*OBS: Somente retire da tomada.* \nAguarde 1 minuto e ligue novamente!`, contact)
    //                           await sleep(2000)
    //                           // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyLiberado);
                             
    //                           await sendFaceMessage({ body: bodyLiberado, ticket });

    //                           const bodyqrcode = formatBody(`Veja se seu acesso voltou! Caso nao tenha voltado retorne o contato e fale com um atendente!`, contact)
    //                           await sleep(2000)
    //                           await sendFaceMessage({ body: bodyqrcode, ticket });

    //                           //await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyqrcode);
    //                         }).catch(async function (error) {
    //                           const bodyfinaliza = formatBody(`Opss! Algo de errado aconteceu! Digite *#* para voltar ao menu anterior e fale com um atendente!`, contact)
    //                           await sendFaceMessage({ body: bodyfinaliza, ticket });

    //                           // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyfinaliza);
    //                         });
    //                       }


    //                       const bodyfinaliza = formatBody(`Estamos finalizando esta conversa! Caso precise entre em contato conosco!`, contact)
    //                       await sleep(12000)
    //                       // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyfinaliza);
    //                       await sendFaceMessage({ body: bodyfinaliza, ticket });

    //                       await sleep(2000)
    //                       fs.unlink(nomePDF, function (err) {
    //                         if (err) throw err;
    //                         console.log(err);
    //                       })

    //                       await UpdateTicketService({
    //                         ticketData: { status: "closed" },
    //                         ticketId: ticket.id,
    //                         companyId: ticket.companyId,
    //                       });

    //                     } catch (error) {
    //                       console.log('11 Não consegui enviar a mensagem!')
    //                     }
    //                   }
    //                 })
    //                 .catch(async function (error) {
    //                   try {
    //                     const bodyBoleto = formatBody(`Não consegui encontrar seu cadastro.\n\nPor favor tente novamente!\nOu digite *#* para voltar ao *Menu Anterior*`, contact)
    //                     await sleep(2000)
    //                     // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyBoleto);
    //                     await sendFaceMessage({ body: bodyBoleto, ticket });

    //                   } catch (error) {
    //                     console.log('111 Não consegui enviar a mensagem!')
    //                   }

    //                 });
    //             })
    //             .catch(async function (error) {
    //               const bodyfinaliza = formatBody(`Opss! Algo de errado aconteceu! Digite *#* para voltar ao menu anterior e fale com um atendente!`, contact)
                  
    //               await sendFaceMessage({ body: bodyfinaliza, ticket });

    //               // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyfinaliza);
    //             });
    //         } else {
    //           const body = formatBody(`Este CPF/CNPJ não é válido!\n\nPor favor tente novamente!\nOu digite *#* para voltar ao *Menu Anterior*`, contact)
    //           await sleep(2000)
    //           await sendFaceMessage({ body: body, ticket });

    //           // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, body);
    //         }
    //       }
    //     }
    //   }

    //   if (asaastoken.value !== "") {
    //     if (isNumeric(numberCPFCNPJ) === true) {
    //       if (cpfcnpj.length > 2) {
    //         const isCPFCNPJ = validaCpfCnpj(numberCPFCNPJ)
    //         if (isCPFCNPJ) {
    //           const body = formatBody(`Aguarde! Estamos consultando na base de dados!`, contact);
    //           try {
    //             await sleep(2000)
    //             // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, body);
    //             await sendFaceMessage({ body: body, ticket });

    //           } catch (error) {
    //             //console.log('Não consegui enviar a mensagem!')
    //           }
    //           var optionsc = {
    //             method: 'GET',
    //             url: 'https://www.asaas.com/api/v3/customers',
    //             params: { cpfCnpj: numberCPFCNPJ },
    //             headers: {
    //               'Content-Type': 'application/json',
    //               access_token: asaastk
    //             }
    //           };

    //           axios.request(optionsc as any).then(async function (response) {
    //             let nome;
    //             let id_cliente;
    //             let totalCount;

    //             nome = response?.data?.data[0]?.name;
    //             id_cliente = response?.data?.data[0]?.id;
    //             totalCount = response?.data?.totalCount;

    //             if (totalCount === 0) {
    //               const body = formatBody(`Cadastro não localizado! *CPF/CNPJ* incorreto ou inválido. Tenta novamente!`, contact);
    //               await sleep(2000)
    //               // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, body);
    //               await sendFaceMessage({ body: body, ticket });

    //             } else {

    //               const body = formatBody(`Localizei seu Cadastro! \n*${nome}* só mais um instante por favor!`, contact);
    //               await sleep(2000)
    //               await sendFaceMessage({ body: body, ticket });

    //               // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, body);
    //               var optionsListpaymentOVERDUE = {
    //                 method: 'GET',
    //                 url: 'https://www.asaas.com/api/v3/payments',
    //                 params: { customer: id_cliente, status: 'OVERDUE' },
    //                 headers: {
    //                   'Content-Type': 'application/json',
    //                   access_token: asaastk
    //                 }
    //               };

    //               axios.request(optionsListpaymentOVERDUE as any).then(async function (response) {
    //                 let totalCount_overdue;
    //                 totalCount_overdue = response?.data?.totalCount;

    //                 if (totalCount_overdue === 0) {
    //                   const body = formatBody(`Você não tem nenhuma fatura vencidada! \nVou te enviar a proxima fatura. Por favor aguarde!`, contact);
    //                   await sleep(2000)
    //                   // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, body);
    //                   await sendFaceMessage({ body: body, ticket });

    //                   var optionsPENDING = {
    //                     method: 'GET',
    //                     url: 'https://www.asaas.com/api/v3/payments',
    //                     params: { customer: id_cliente, status: 'PENDING' },
    //                     headers: {
    //                       'Content-Type': 'application/json',
    //                       access_token: asaastk
    //                     }
    //                   };

    //                   axios.request(optionsPENDING as any).then(async function (response) {
    //                     function sortfunction(a, b) {
    //                       return a.dueDate.localeCompare(b.dueDate);
    //                     }
    //                     const ordenado = response?.data?.data.sort(sortfunction);
    //                     let id_payment_pending;
    //                     let value_pending;
    //                     let description_pending;
    //                     let invoiceUrl_pending;
    //                     let dueDate_pending;
    //                     let invoiceNumber_pending;
    //                     let totalCount_pending;
    //                     let value_pending_corrigida;
    //                     let dueDate_pending_corrigida;

    //                     id_payment_pending = ordenado[0]?.id;
    //                     value_pending = ordenado[0]?.value;
    //                     description_pending = ordenado[0]?.description;
    //                     invoiceUrl_pending = ordenado[0]?.invoiceUrl;
    //                     dueDate_pending = ordenado[0]?.dueDate;
    //                     invoiceNumber_pending = ordenado[0]?.invoiceNumber;
    //                     totalCount_pending = response?.data?.totalCount;

    //                     dueDate_pending_corrigida = dueDate_pending?.split('-')?.reverse()?.join('/');
    //                     value_pending_corrigida = value_pending.toLocaleString('pt-br', { style: 'currency', currency: 'BRL' });

    //                     const bodyBoleto = formatBody(`Segue a segunda-via da sua Fatura!\n\n*Fatura:* ${invoiceNumber_pending}\n*Nome:* ${nome}\n*Valor:* R$ ${value_pending_corrigida}\n*Data Vencimento:* ${dueDate_pending_corrigida}\n*Descrição:*\n${description_pending}\n*Link:* ${invoiceUrl_pending}`, contact);
    //                     await sleep(2000)
    //                     // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyBoleto);
    //                     await sendFaceMessage({ body: body, ticket });

    //                     //GET DADOS PIX
    //                     var optionsGetPIX = {
    //                       method: 'GET',
    //                       url: `https://www.asaas.com/api/v3/payments/${id_payment_pending}/pixQrCode`,
    //                       headers: {
    //                         'Content-Type': 'application/json',
    //                         access_token: asaastk
    //                       }
    //                     };

    //                     axios.request(optionsGetPIX as any).then(async function (response) {
    //                       let success;
    //                       let payload;

    //                       success = response?.data?.success;
    //                       payload = response?.data?.payload;

    //                       if (success === true) {
    //                         const bodyPixCP = formatBody(`Este é o *PIX Copia e Cola*`, contact);
    //                         await sleep(2000)
    //                         // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyPixCP);
                            
    //                         await sendFaceMessage({ body: body, ticket });

    //                         const bodyPix = formatBody(`${payload}`, contact);
    //                         await sleep(2000)
    //                         await sendFaceMessage({ body: body, ticket });

    //                         // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyPix);
    //                         let linkBoleto = `https://chart.googleapis.com/chart?cht=qr&chs=500x500&chld=L|0&chl=${payload}`
    //                         await sleep(2000)
    //                         await sendMessageImage(contact, ticket, linkBoleto, '')
    //                         var optionsBoletopend = {
    //                           method: 'GET',
    //                           url: `https://www.asaas.com/api/v3/payments/${id_payment_pending}/identificationField`,
    //                           headers: {
    //                             'Content-Type': 'application/json',
    //                             access_token: asaastk
    //                           }
    //                         };

    //                         axios.request(optionsBoletopend as any).then(async function (response) {
    //                           let codigo_barras
    //                           codigo_barras = response.data.identificationField;
    //                           const bodycodigoBarras = formatBody(`${codigo_barras}`, contact);
    //                           if (response.data?.errors?.code !== 'invalid_action') {
    //                             const bodycodigo = formatBody(`Este é o *Código de Barras*!`, contact);
    //                             await sleep(2000)
    //                             // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodycodigo);
    //                             await sendFaceMessage({ body: bodycodigo, ticket });

    //                             await sleep(2000)
    //                             // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodycodigoBarras);
    //                             await sendFaceMessage({ body: bodycodigoBarras, ticket });

                               
    //                             const bodyfinaliza = formatBody(`Estamos finalizando esta conversa! Caso precise entre em contato conosco!`, contact);
    //                             await sleep(2000)
    //                             // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyfinaliza);
    //                             await sendFaceMessage({ body: bodycodigoBarras, ticket });

    //                             await sleep(2000)
    //                             await UpdateTicketService({
    //                               ticketData: { status: "closed" },
    //                               ticketId: ticket.id,
    //                               companyId: ticket.companyId,
    //                             });
    //                           } else {
    //                             const bodyfinaliza = formatBody(`Estamos finalizando esta conversa! Caso precise entre em contato conosco!`, contact);
    //                             await sleep(2000)
    //                             // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyfinaliza);
    //                             await sendFaceMessage({ body: bodycodigoBarras, ticket });

    //                             await UpdateTicketService({
    //                               ticketData: { status: "closed" },
    //                               ticketId: ticket.id,
    //                               companyId: ticket.companyId,
    //                             });
    //                           }

    //                         }).catch(async function (error) {
    //                           const bodyfinaliza = formatBody(`Estamos finalizando esta conversa! Caso precise entre em contato conosco!`, contact);
    //                           await sleep(2000)
    //                           // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyfinaliza);
    //                           await sendFaceMessage({ body: bodyfinaliza, ticket });

    //                           await UpdateTicketService({
    //                             ticketData: { status: "closed" },
    //                             ticketId: ticket.id,
    //                             companyId: ticket.companyId,
    //                           });
    //                         });
    //                       }

    //                     }).catch(async function (error) {
    //                       const body = formatBody(`*Opss!!!!*\nOcorreu um erro! Digite *#* e fale com um *Atendente*!`, contact);
    //                       await sleep(2000)
    //                       // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, body);
    //                       await sendFaceMessage({ body: body, ticket });

    //                     });

    //                   }).catch(async function (error) {
    //                     const body = formatBody(`*Opss!!!!*\nOcorreu um erro! Digite *#* e fale com um *Atendente*!`, contact);
    //                     await sleep(2000)
    //                     // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, body);
    //                     await sendFaceMessage({ body: body, ticket });

    //                   });
    //                 } else {
    //                   let id_payment_overdue;
    //                   let value_overdue;
    //                   let description_overdue;
    //                   let invoiceUrl_overdue;
    //                   let dueDate_overdue;
    //                   let invoiceNumber_overdue;

    //                   let value_overdue_corrigida;
    //                   let dueDate_overdue_corrigida;

    //                   id_payment_overdue = response?.data?.data[0]?.id;
    //                   value_overdue = response?.data?.data[0]?.value;
    //                   description_overdue = response?.data?.data[0]?.description;
    //                   invoiceUrl_overdue = response?.data?.data[0]?.invoiceUrl;
    //                   dueDate_overdue = response?.data?.data[0]?.dueDate;
    //                   invoiceNumber_overdue = response?.data?.data[0]?.invoiceNumber;


    //                   dueDate_overdue_corrigida = dueDate_overdue?.split('-')?.reverse()?.join('/');
    //                   value_overdue_corrigida = value_overdue.toLocaleString('pt-br', { style: 'currency', currency: 'BRL' });
    //                   const body = formatBody(`Você tem *${totalCount_overdue}* fatura(s) vencidada(s)! \nVou te enviar. Por favor aguarde!`, contact);
    //                   await sleep(2000)
    //                   // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, body);
                      
    //                   await sendFaceMessage({ body: body, ticket });

                      
    //                   const bodyBoleto = formatBody(`Segue a segunda-via da sua Fatura!\n\n*Fatura:* ${invoiceNumber_overdue}\n*Nome:* ${nome}\n*Valor:* R$ ${value_overdue_corrigida}\n*Data Vencimento:* ${dueDate_overdue_corrigida}\n*Descrição:*\n${description_overdue}\n*Link:* ${invoiceUrl_overdue}`, contact);
    //                   await sleep(2000)
    //                   await sendFaceMessage({ body: bodyBoleto, ticket });

    //                   // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyBoleto);
    //                   //GET DADOS PIX
    //                   var optionsGetPIX = {
    //                     method: 'GET',
    //                     url: `https://www.asaas.com/api/v3/payments/${id_payment_overdue}/pixQrCode`,
    //                     headers: {
    //                       'Content-Type': 'application/json',
    //                       access_token: asaastk
    //                     }
    //                   };

    //                   axios.request(optionsGetPIX as any).then(async function (response) {
    //                     let success;
    //                     let payload;

    //                     success = response?.data?.success;
    //                     payload = response?.data?.payload;
    //                     if (success === true) {

    //                       const bodyPixCP = formatBody(`Este é o *PIX Copia e Cola*`, contact);
    //                       await sleep(2000)
    //                       // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyPixCP);

    //                       await sendFaceMessage({ body: bodyPixCP, ticket });

    //                       const bodyPix = formatBody(`${payload}`, contact);
    //                       await sleep(2000)
    //                       // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyPix);

    //                       await sendFaceMessage({ body: bodyPix, ticket });

    //                       let linkBoleto = `https://chart.googleapis.com/chart?cht=qr&chs=500x500&chld=L|0&chl=${payload}`
    //                       await sleep(2000)
    //                       await sendMessageImage( contact, ticket, linkBoleto, '')
    //                       var optionsBoleto = {
    //                         method: 'GET',
    //                         url: `https://www.asaas.com/api/v3/payments/${id_payment_overdue}/identificationField`,
    //                         headers: {
    //                           'Content-Type': 'application/json',
    //                           access_token: asaastk
    //                         }
    //                       };

    //                       axios.request(optionsBoleto as any).then(async function (response) {

    //                         let codigo_barras
    //                         codigo_barras = response.data.identificationField;
    //                         const bodycodigoBarras = formatBody(`${codigo_barras}`, contact);
    //                         if (response.data?.errors?.code !== 'invalid_action') {
    //                           const bodycodigo = formatBody(`Este é o *Código de Barras*!`, contact);
    //                           await sleep(2000)
    //                           await sendFaceMessage({ body: bodycodigo, ticket });

    //                           // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodycodigo);
    //                           await sleep(2000)
    //                           await sendFaceMessage({ body: bodycodigoBarras, ticket });

    //                           // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodycodigoBarras);
    //                           const bodyfinaliza = formatBody(`Estamos finalizando esta conversa! Caso precise entre em contato conosco!`, contact);
    //                           await sleep(2000)
    //                           await sendFaceMessage({ body: bodyfinaliza, ticket });

    //                           // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyfinaliza);
    //                           await UpdateTicketService({
    //                             ticketData: { status: "closed" },
    //                             ticketId: ticket.id,
    //                             companyId: ticket.companyId,
    //                           });
    //                         } else {
    //                           const bodyfinaliza = formatBody(`Estamos finalizando esta conversa! Caso precise entre em contato conosco!`, contact);
    //                           await sleep(2000)
    //                           await sendFaceMessage({ body: bodyfinaliza, ticket });

    //                           // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyfinaliza);
    //                           await UpdateTicketService({
    //                             ticketData: { status: "closed" },
    //                             ticketId: ticket.id,
    //                             companyId: ticket.companyId,
    //                           });
    //                         }

    //                       }).catch(function (error) {
    //                         //console.error(error);
    //                       });

    //                     }
    //                   }).catch(function (error) {

    //                   });

    //                 }

    //               }).catch(async function (error) {
    //                 const body = formatBody(`*Opss!!!!*\nOcorreu um erro! Digite *#* e fale com um *Atendente*!`, contact);
    //                 await sleep(2000)
    //                 // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, body);
    //                 await sendFaceMessage({ body: body, ticket });

    //               });
    //             }
    //           }).catch(async function (error) {
    //             const body = formatBody(`*Opss!!!!*\nOcorreu um erro! Digite *#* e fale com um *Atendente*!`, contact);
    //             await sleep(2000)
    //             await sendFaceMessage({ body: body, ticket });

    //             // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, body);
    //           });
    //         }
    //       }
    //     }
    //   }

    //   if (ixcapikey.value != "" && urlixcdb.value != "") {
    //     if (isNumeric(numberCPFCNPJ) === true) {
    //       if (cpfcnpj.length > 2) {
    //         const isCPFCNPJ = validaCpfCnpj(numberCPFCNPJ)
    //         if (isCPFCNPJ) {
    //           if (numberCPFCNPJ.length <= 11) {
    //             numberCPFCNPJ = numberCPFCNPJ.replace(/(\d{3})(\d)/, "$1.$2")
    //             numberCPFCNPJ = numberCPFCNPJ.replace(/(\d{3})(\d)/, "$1.$2")
    //             numberCPFCNPJ = numberCPFCNPJ.replace(/(\d{3})(\d{1,2})$/, "$1-$2")
    //           } else {
    //             numberCPFCNPJ = numberCPFCNPJ.replace(/^(\d{2})(\d)/, "$1.$2")
    //             numberCPFCNPJ = numberCPFCNPJ.replace(/^(\d{2})\.(\d{3})(\d)/, "$1.$2.$3")
    //             numberCPFCNPJ = numberCPFCNPJ.replace(/\.(\d{3})(\d)/, ".$1/$2")
    //             numberCPFCNPJ = numberCPFCNPJ.replace(/(\d{4})(\d)/, "$1-$2")
    //           }
    //           //const token = await CheckSettingsHelper("OBTEM O TOKEN DO BANCO (dei insert na tabela settings)")
    //           const body = formatBody(`Aguarde! Estamos consultando na base de dados!`, contact);
    //           try {
    //             await sleep(2000)
    //             // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, body);
    //             await sendFaceMessage({ body: body, ticket });

    //           } catch (error) {
    //             //console.log('Não consegui enviar a mensagem!')
    //           }
    //           var options = {
    //             method: 'GET',
    //             url: `${urlixc}/webservice/v1/cliente`,
    //             headers: {
    //               ixcsoft: 'listar',
    //               Authorization: `Basic ${ixckeybase64}`
    //             },
    //             data: {
    //               qtype: 'cliente.cnpj_cpf',
    //               query: numberCPFCNPJ,
    //               oper: '=',
    //               page: '1',
    //               rp: '1',
    //               sortname: 'cliente.cnpj_cpf',
    //               sortorder: 'asc'
    //             }
    //           };

    //           axios.request(options as any).then(async function (response) {
    //             if (response.data.type === 'error') {
    //               console.log("Error response", response.data.message);
    //               const body = formatBody(`*Opss!!!!*\nOcorreu um erro! Digite *#* e fale com um *Atendente*!`, contact);
    //               await sleep(2000)
    //               // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, body);
    //               await sendFaceMessage({ body: body, ticket });

    //             } if (response.data.total === 0) {
    //               const body = formatBody(`Cadastro não localizado! *CPF/CNPJ* incorreto ou inválido. Tenta novamente!`, contact);
    //               try {
    //                 await sleep(2000)
    //                 // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, body);
    //                 await sendFaceMessage({ body: body, ticket });

    //               } catch (error) {
    //                 //console.log('Não consegui enviar a mensagem!')
    //               }
    //             } else {

    //               let nome;
    //               let id;
    //               let type;

    //               nome = response.data?.registros[0]?.razao
    //               id = response.data?.registros[0]?.id
    //               type = response.data?.type


    //               const body = formatBody(`Localizei seu Cadastro! \n*${nome}* só mais um instante por favor!`, contact);
    //               await sleep(2000)
    //               // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, body);
    //               await sendFaceMessage({ body: body, ticket });

    //               var boleto = {
    //                 method: 'GET',
    //                 url: `${urlixc}/webservice/v1/fn_areceber`,
    //                 headers: {
    //                   ixcsoft: 'listar',
    //                   Authorization: `Basic ${ixckeybase64}`
    //                 },
    //                 data: {
    //                   qtype: 'fn_areceber.id_cliente',
    //                   query: id,
    //                   oper: '=',
    //                   page: '1',
    //                   rp: '1',
    //                   sortname: 'fn_areceber.data_vencimento',
    //                   sortorder: 'asc',
    //                   grid_param: '[{"TB":"fn_areceber.status", "OP" : "=", "P" : "A"}]'
    //                 }
    //               };
    //               axios.request(boleto as any).then(async function (response) {



    //                 let gateway_link;
    //                 let valor;
    //                 let datavenc;
    //                 let datavencCorrigida;
    //                 let valorCorrigido;
    //                 let linha_digitavel;
    //                 let impresso;
    //                 let idboleto;

    //                 idboleto = response.data?.registros[0]?.id
    //                 gateway_link = response.data?.registros[0]?.gateway_link
    //                 valor = response.data?.registros[0]?.valor
    //                 datavenc = response.data?.registros[0]?.data_vencimento
    //                 linha_digitavel = response.data?.registros[0]?.linha_digitavel
    //                 impresso = response.data?.registros[0]?.impresso
    //                 valorCorrigido = valor.replace(".", ",");
    //                 datavencCorrigida = datavenc.split('-').reverse().join('/')

    //                 //console.log(response.data?.registros[0])
    //                 //INFORMAÇÕES BOLETO
    //                 const bodyBoleto = {
    //                   text: formatBody(`Segue a segunda-via da sua Fatura!\n\n*Fatura:* ${idboleto}\n*Nome:* ${nome}\n*Valor:* R$ ${valorCorrigido}\n*Data Vencimento:* ${datavencCorrigida}\n\nVou mandar o *código de barras* na próxima mensagem para ficar mais fácil para você copiar!`, contact),
    //                 };
    //                 //await sleep(2000)
    //                 //await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyBoleto);
    //                 //LINHA DIGITAVEL                    
    //                 if (impresso !== "S") {
    //                   //IMPRIME BOLETO PARA GERAR CODIGO BARRAS
    //                   var boletopdf = {
    //                     method: 'GET',
    //                     url: `${urlixc}/webservice/v1/get_boleto`,
    //                     headers: {
    //                       ixcsoft: 'listar',
    //                       Authorization: `Basic ${ixckeybase64}`
    //                     },
    //                     data: {
    //                       boletos: idboleto,
    //                       juro: 'N',
    //                       multa: 'N',
    //                       atualiza_boleto: 'N',
    //                       tipo_boleto: 'arquivo',
    //                       base64: 'S'
    //                     }
    //                   };

    //                   axios.request(boletopdf as any).then(function (response) {
    //                   }).catch(function (error) {
    //                     console.error(error);
    //                   });
    //                 }

    //                 //SE TIVER PIX ENVIA O PIX
    //                 var optionsPix = {
    //                   method: 'GET',
    //                   url: `${urlixc}/webservice/v1/get_pix`,
    //                   headers: {
    //                     ixcsoft: 'listar',
    //                     Authorization: `Basic ${ixckeybase64}`
    //                   },
    //                   data: { id_areceber: idboleto }
    //                 };

    //                 axios.request(optionsPix as any).then(async function (response) {
    //                   let tipo;
    //                   let pix;

    //                   tipo = response.data?.type;
    //                   pix = response.data?.pix?.qrCode?.qrcode;
    //                   if (tipo === 'success') {
    //                     const bodyBoletoPix = formatBody(`Segue a segunda-via da sua Fatura!\n\n*Fatura:* ${idboleto}\n*Nome:* ${nome}\n*Valor:* R$ ${valorCorrigido}\n*Data Vencimento:* ${datavencCorrigida}\n\nVou te enviar o *Código de Barras* e o *PIX* basta clicar em qual você quer utlizar que já vai copiar! Depois basta realizar o pagamento no seu banco`, contact);
    //                     // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyBoletoPix);
                        
    //                     await sendFaceMessage({ body: body, ticket });

    //                     const body_linhadigitavel = formatBody("Este é o *Código de Barras*", contact);
    //                     await sleep(2000)
    //                     // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, body_linhadigitavel);
    //                     await sendFaceMessage({ body: body_linhadigitavel, ticket });

    //                     await sleep(2000)
    //                     const body_linha_digitavel = formatBody(`${linha_digitavel}`, contact);
    //                     await sendFaceMessage({ body: body_linha_digitavel, ticket });

    //                     // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, body_linha_digitavel);
    //                     const body_pix = formatBody("Este é o *PIX Copia e Cola*", contact);
    //                     await sleep(2000)
    //                     // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, body_pix);
    //                     await sendFaceMessage({ body: body_pix, ticket });

    //                     await sleep(2000)
    //                     const body_pix_dig = formatBody(`${pix}`, contact);
    //                     // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, body_pix_dig);
    //                     await sendFaceMessage({ body: body_pix, ticket });

    //                     const body_pixqr = formatBody("QR CODE do *PIX*", contact);
    //                     await sleep(2000)
    //                     await sendFaceMessage({ body: body_pix, ticket });

    //                     // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, body_pixqr);
    //                     let linkBoleto = `https://chart.googleapis.com/chart?cht=qr&chs=500x500&chld=L|0&chl=${pix}`
    //                     await sleep(2000)
    //                     await sendMessageImage(contact, ticket, linkBoleto, '')
    //                     ///VE SE ESTA BLOQUEADO PARA LIBERAR!
    //                     var optionscontrato = {
    //                       method: 'POST',
    //                       url: `${urlixc}/webservice/v1/cliente_contrato`,
    //                       headers: {
    //                         ixcsoft: 'listar',
    //                         Authorization: `Basic ${ixckeybase64}`
    //                       },
    //                       data: {
    //                         qtype: 'cliente_contrato.id_cliente',
    //                         query: id,
    //                         oper: '=',
    //                         page: '1',
    //                         rp: '1',
    //                         sortname: 'cliente_contrato.id',
    //                         sortorder: 'asc'
    //                       }
    //                     };
    //                     axios.request(optionscontrato as any).then(async function (response) {
    //                       let status_internet;
    //                       let id_contrato;
    //                       status_internet = response.data?.registros[0]?.status_internet;
    //                       id_contrato = response.data?.registros[0]?.id;
    //                       if (status_internet !== 'A') {
    //                         const bodyPdf = formatBody(`*${nome}* vi tambem que a sua conexão esta bloqueada! Vou desbloquear para você.`, contact);
    //                         await sleep(2000)
    //                         // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyPdf);
    //                         await sendFaceMessage({ body: body_pix, ticket });

    //                         const bodyqrcode = formatBody(`Estou liberando seu acesso. Por favor aguarde!`, contact);
    //                         await sleep(2000)
    //                         // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyqrcode);
    //                         await sendFaceMessage({ body: body_pix, ticket });

    //                         //REALIZANDO O DESBLOQUEIO   
    //                         var optionsdesbloqeuio = {
    //                           method: 'POST',
    //                           url: `${urlixc}/webservice/v1/desbloqueio_confianca`,
    //                           headers: {
    //                             Authorization: `Basic ${ixckeybase64}`
    //                           },
    //                           data: { id: id_contrato }
    //                         };

    //                         axios.request(optionsdesbloqeuio as any).then(async function (response) {
    //                           let tipo;
    //                           let mensagem;
    //                           tipo = response.data?.tipo;
    //                           mensagem = response.data?.mensagem;
    //                           if (tipo === 'sucesso') {
    //                             //DESCONECTANDO O CLIENTE PARA VOLTAR O ACESSO
    //                             var optionsRadius = {
    //                               method: 'GET',
    //                               url: `${urlixc}/webservice/v1/radusuarios`,
    //                               headers: {
    //                                 ixcsoft: 'listar',
    //                                 Authorization: `Basic ${ixckeybase64}`
    //                               },
    //                               data: {
    //                                 qtype: 'radusuarios.id_cliente',
    //                                 query: id,
    //                                 oper: '=',
    //                                 page: '1',
    //                                 rp: '1',
    //                                 sortname: 'radusuarios.id',
    //                                 sortorder: 'asc'
    //                               }
    //                             };

    //                             axios.request(optionsRadius as any).then(async function (response) {
    //                               let tipo;
    //                               tipo = response.data?.type;
    //                               if (tipo === 'success') {
    //                                 const body_mensagem = formatBody(`${mensagem}`, contact);
    //                                 await sleep(2000)
    //                                 // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, body_mensagem);
    //                                 await sendFaceMessage({ body: body_mensagem, ticket });

    //                                 const bodyPdf = formatBody(`Fiz os procedimentos de liberação! Agora aguarde até 5 minutos e veja se sua conexão irá retornar! .\n\nCaso não tenha voltado, retorne o contato e fale com um atendente!`, contact);
    //                                 await sleep(2000)
    //                                 await sendFaceMessage({ body: bodyPdf, ticket });

    //                                 // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyPdf);
    //                                 const bodyfinaliza = formatBody(`Estamos finalizando esta conversa! Caso precise entre em contato conosco!`, contact);
    //                                 await sleep(2000)
    //                                 await sendFaceMessage({ body: bodyfinaliza, ticket });

    //                                 // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyfinaliza);
    //                                 await UpdateTicketService({
    //                                   ticketData: { status: "closed" },
    //                                   ticketId: ticket.id,
    //                                   companyId: ticket.companyId,
    //                                 });
    //                               }
    //                             }).catch(function (error) {
    //                               console.error(error);
    //                             });
    //                             //FIM DA DESCONEXÃO 
    //                           } else {
    //                             var msgerrolbieracao = response.data.mensagem
    //                             const bodyerro = formatBody(`Ops! Ocorreu um erro e nao consegui desbloquear`, contact);
    //                             const msg_errolbieracao = formatBody(`${msgerrolbieracao}`, contact);
    //                             await sleep(2000)
    //                             await sendFaceMessage({ body: msg_errolbieracao, ticket });

    //                             // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyerro);
    //                             await sleep(2000)
    //                             await sendFaceMessage({ body: msg_errolbieracao, ticket });

    //                             // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, msg_errolbieracao);
    //                             const bodyerroatendent = formatBody(`Digite *#* para voltar o menu e fale com um atendente!`, contact);
    //                             await sleep(2000)
    //                             await sendFaceMessage({ body: bodyerroatendent, ticket });

    //                             // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyerroatendent);
    //                           }

    //                         }).catch(async function (error) {
    //                           const bodyerro = formatBody(`Ops! Ocorreu um erro digite *#* e fale com um atendente!`, contact);
    //                           await sleep(2000)
    //                           await sendFaceMessage({ body: bodyerro, ticket });

    //                           // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyerro);
    //                         });
    //                       } else {
    //                         const bodyfinaliza = formatBody(`Estamos finalizando esta conversa! Caso precise entre em contato conosco!`, contact);
    //                         await sleep(8000)
    //                         await sendFaceMessage({ body: bodyfinaliza, ticket });

    //                         // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyfinaliza);
    //                         await UpdateTicketService({
    //                           ticketData: { status: "closed" },
    //                           ticketId: ticket.id,
    //                           companyId: ticket.companyId,
    //                         });
    //                       }

    //                       //
    //                     }).catch(async function (error) {

    //                       const bodyerro = formatBody(`Ops! Ocorreu um erro digite *#* e fale com um atendente!`, contact);
    //                       await sleep(2000)
    //                       await sendFaceMessage({ body: bodyerro, ticket });

    //                       // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyerro);
    //                     });
    //                     ///VE SE ESTA BLOQUEADO PARA LIBERAR!
    //                   } else {
    //                     const bodyBoleto = formatBody(`Segue a segunda-via da sua Fatura!\n\n*Fatura:* ${idboleto}\n*Nome:* ${nome}\n*Valor:* R$ ${valorCorrigido}\n*Data Vencimento:* ${datavencCorrigida}\n\nBasta clicar aqui em baixo em código de barras para copiar, apos isto basta realizar o pagamento em seu banco!`, contact);
                        
    //                     await sleep(2000)
    //                     await sendFaceMessage({ body: bodyBoleto, ticket });

    //                     // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyBoleto);
    //                     const body = formatBody(`Este é o *Codigo de Barras*`, contact);
    //                     await sleep(2000)
    //                     // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, body);
    //                     await sendFaceMessage({ body: body, ticket });

    //                     await sleep(2000)
    //                     const body_linha_digitavel = formatBody(`${linha_digitavel}`, contact);
    //                     await sendFaceMessage({ body: body_linha_digitavel, ticket });

    //                     // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, body_linha_digitavel);
    //                     ///VE SE ESTA BLOQUEADO PARA LIBERAR!
    //                     var optionscontrato = {
    //                       method: 'POST',
    //                       url: `${urlixc}/webservice/v1/cliente_contrato`,
    //                       headers: {
    //                         ixcsoft: 'listar',
    //                         Authorization: `Basic ${ixckeybase64}`
    //                       },
    //                       data: {
    //                         qtype: 'cliente_contrato.id_cliente',
    //                         query: id,
    //                         oper: '=',
    //                         page: '1',
    //                         rp: '1',
    //                         sortname: 'cliente_contrato.id',
    //                         sortorder: 'asc'
    //                       }
    //                     };
    //                     axios.request(optionscontrato as any).then(async function (response) {
    //                       let status_internet;
    //                       let id_contrato;
    //                       status_internet = response.data?.registros[0]?.status_internet;
    //                       id_contrato = response.data?.registros[0]?.id;
    //                       if (status_internet !== 'A') {
    //                         const bodyPdf = formatBody(`*${nome}* vi tambem que a sua conexão esta bloqueada! Vou desbloquear para você.`, contact);
    //                         await sleep(2000)
    //                         // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyPdf);
    //                         await sendFaceMessage({ body: bodyPdf, ticket });

    //                         const bodyqrcode = formatBody(`Estou liberando seu acesso. Por favor aguarde!`, contact)
    //                         await sleep(2000)
    //                         // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyqrcode);
    //                         await sendFaceMessage({ body: bodyqrcode, ticket });

    //                         //REALIZANDO O DESBLOQUEIO   
    //                         var optionsdesbloqeuio = {
    //                           method: 'POST',
    //                           url: `${urlixc}/webservice/v1/desbloqueio_confianca`,
    //                           headers: {
    //                             Authorization: `Basic ${ixckeybase64}`
    //                           },
    //                           data: { id: id_contrato }
    //                         };

    //                         axios.request(optionsdesbloqeuio as any).then(async function (response) {
    //                           let tipo;
    //                           let mensagem;
    //                           tipo = response.data?.tipo;
    //                           mensagem = response.data?.mensagem;
    //                           if (tipo === 'sucesso') {
    //                             //DESCONECTANDO O CLIENTE PARA VOLTAR O ACESSO
    //                             var optionsRadius = {
    //                               method: 'GET',
    //                               url: `${urlixc}/webservice/v1/radusuarios`,
    //                               headers: {
    //                                 ixcsoft: 'listar',
    //                                 Authorization: `Basic ${ixckeybase64}`
    //                               },
    //                               data: {
    //                                 qtype: 'radusuarios.id_cliente',
    //                                 query: id,
    //                                 oper: '=',
    //                                 page: '1',
    //                                 rp: '1',
    //                                 sortname: 'radusuarios.id',
    //                                 sortorder: 'asc'
    //                               }
    //                             };

    //                             axios.request(optionsRadius as any).then(async function (response) {
    //                               let tipo;
    //                               tipo = response.data?.type;
    //                               const body_mensagem = formatBody(`${mensagem}`, contact);
    //                               if (tipo === 'success') {
    //                                 await sleep(2000)
    //                                 await sendFaceMessage({ body: body_mensagem, ticket });

    //                                 // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, body_mensagem);
    //                                 const bodyPdf = formatBody(`Fiz os procedimentos de liberação! Agora aguarde até 5 minutos e veja se sua conexão irá retornar! .\n\nCaso não tenha voltado, retorne o contato e fale com um atendente!`, contact);
    //                                 await sleep(2000)
    //                                 await sendFaceMessage({ body: bodyPdf, ticket });

    //                                 // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyPdf);
    //                                 const bodyfinaliza = formatBody(`Estamos finalizando esta conversa! Caso precise entre em contato conosco!`, contact);
    //                                 await sleep(2000)
    //                                 await sendFaceMessage({ body: bodyfinaliza, ticket });

    //                                 // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyfinaliza);
    //                                 await UpdateTicketService({
    //                                   ticketData: { status: "closed" },
    //                                   ticketId: ticket.id,
    //                                   companyId: ticket.companyId,
    //                                 });
    //                               } else {
    //                                 await sleep(2000)
    //                                 await sendFaceMessage({ body: body_mensagem, ticket });

    //                                 // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, body_mensagem);
    //                                 const bodyPdf = formatBody(`Vou precisar que você *retire* seu equipamento da tomada.\n\n*OBS: Somente retire da tomada.* \nAguarde 1 minuto e ligue novamente!`, contact);
    //                                 await sleep(2000)
    //                                 await sendFaceMessage({ body: bodyPdf, ticket });

    //                                 // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyPdf);
    //                                 const bodyqrcode = formatBody(`Veja se seu acesso voltou! Caso não tenha voltado retorne o contato e fale com um atendente!`, contact);
                                    
    //                                 await sleep(2000)
    //                                 await sendFaceMessage({ body: bodyPdf, ticket });

    //                                 // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyqrcode);
    //                                 const bodyfinaliza = formatBody(`Estamos finalizando esta conversa! Caso precise entre em contato conosco!`, contact);
    //                                 await sleep(2000)
    //                                 // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyfinaliza);
    //                                 await sendFaceMessage({ body: bodyfinaliza, ticket });

    //                                 await UpdateTicketService({
    //                                   ticketData: { status: "closed" },
    //                                   ticketId: ticket.id,
    //                                   companyId: ticket.companyId,
    //                                 });
    //                               }
    //                             }).catch(function (error) {
    //                               console.error(error);
    //                             });
    //                             //FIM DA DESCONEXÃO 
    //                           } else {
    //                             const bodyerro = formatBody(`Ops! Ocorreu um erro e nao consegui desbloquear! Digite *#* e fale com um atendente!`, contact);
    //                             await sleep(2000)

    //                             await sendFaceMessage({ body: bodyerro, ticket });

    //                             // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyerro);
    //                           }

    //                         }).catch(async function (error) {
    //                           const bodyerro = formatBody(`Ops! Ocorreu um erro digite *#* e fale com um atendente!`, contact);
    //                           await sleep(2000)
    //                           await sendFaceMessage({ body: bodyerro, ticket });

    //                           // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyerro);
    //                         });
    //                       } else {
    //                         const bodyfinaliza = formatBody(`Estamos finalizando esta conversa! Caso precise entre em contato conosco!`, contact);
    //                         await sleep(2000)

    //                         await sendFaceMessage({ body: bodyfinaliza, ticket });

    //                         // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyfinaliza);
    //                         await UpdateTicketService({
    //                           ticketData: { status: "closed" },
    //                           ticketId: ticket.id,
    //                           companyId: ticket.companyId,
    //                         });
    //                       }

    //                       //
    //                     }).catch(async function (error) {
    //                       const bodyerro = formatBody(`Ops! Ocorreu um erro digite *#* e fale com um atendente!`, contact);
    //                       await sleep(2000)

    //                       await sendFaceMessage({ body: bodyerro, ticket });

    //                       // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyerro);
    //                     });
    //                     ///VE SE ESTA BLOQUEADO PARA LIBERAR!                            
    //                   }
    //                 }).catch(function (error) {
    //                   console.error(error);
    //                 });
    //                 //FIM DO PÌX



    //               }).catch(function (error) {
    //                 console.error(error);
    //               });

    //             }

    //           }).catch(async function (error) {
    //             const body = formatBody(`*Opss!!!!*\nOcorreu um erro! Digite *#* e fale com um *Atendente*!`, contact);
    //             await sleep(2000)
    //             // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, body);
    //             await sendFaceMessage({ body: body, ticket });

    //           });
    //         } else {
    //           const body = formatBody(`Este CPF/CNPJ não é válido!\n\nPor favor tente novamente!\nOu digite *#* para voltar ao *Menu Anterior*`, contact);
    //           await sleep(2000)
    //           await sendFaceMessage({ body: body, ticket });

    //           // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, body);
    //         }
    //       }
    //     }


    //   }
    // }

    // if (filaescolhida === "Religue de Confiança" || filaescolhida === "Liberação em Confiança") {
    //   let cpfcnpj
    //   cpfcnpj = message;
    //   cpfcnpj = cpfcnpj.replace(/\./g, '');
    //   cpfcnpj = cpfcnpj.replace('-', '')
    //   cpfcnpj = cpfcnpj.replace('/', '')
    //   cpfcnpj = cpfcnpj.replace(' ', '')
    //   cpfcnpj = cpfcnpj.replace(',', '')

    //   const asaastoken = await Setting.findOne({
    //     where: {
    //       key: "asaas",
    //       companyId
    //     }
    //   });
    //   const ixcapikey = await Setting.findOne({
    //     where: {
    //       key: "tokenixc",
    //       companyId
    //     }
    //   });
    //   const urlixcdb = await Setting.findOne({
    //     where: {
    //       key: "ipixc",
    //       companyId
    //     }
    //   });
    //   const ipmkauth = await Setting.findOne({
    //     where: {
    //       key: "ipmkauth",
    //       companyId
    //     }
    //   });
    //   const clientidmkauth = await Setting.findOne({
    //     where: {
    //       key: "clientidmkauth",
    //       companyId
    //     }
    //   });
    //   const clientesecretmkauth = await Setting.findOne({
    //     where: {
    //       key: "clientsecretmkauth",
    //       companyId
    //     }
    //   });

    //   let urlmkauth = ipmkauth.value
    //   if (urlmkauth.substr(-1) === '/') {
    //     urlmkauth = urlmkauth.slice(0, -1);
    //   }

    //   //VARS
    //   let url = `${urlmkauth}/api/`;
    //   const Client_Id = clientidmkauth.value
    //   const Client_Secret = clientesecretmkauth.value
    //   const ixckeybase64 = btoa(ixcapikey.value);
    //   const urlixc = urlixcdb.value
    //   const asaastk = asaastoken.value

    //   const cnpj_cpf = message;
    //   let numberCPFCNPJ = cpfcnpj;

    //   if (ixcapikey.value != "" && urlixcdb.value != "") {
    //     if (isNumeric(numberCPFCNPJ) === true) {
    //       if (cpfcnpj.length > 2) {
    //         const isCPFCNPJ = validaCpfCnpj(numberCPFCNPJ)
    //         if (isCPFCNPJ) {
    //           if (numberCPFCNPJ.length <= 11) {
    //             numberCPFCNPJ = numberCPFCNPJ.replace(/(\d{3})(\d)/, "$1.$2")
    //             numberCPFCNPJ = numberCPFCNPJ.replace(/(\d{3})(\d)/, "$1.$2")
    //             numberCPFCNPJ = numberCPFCNPJ.replace(/(\d{3})(\d{1,2})$/, "$1-$2")
    //           } else {
    //             numberCPFCNPJ = numberCPFCNPJ.replace(/^(\d{2})(\d)/, "$1.$2")
    //             numberCPFCNPJ = numberCPFCNPJ.replace(/^(\d{2})\.(\d{3})(\d)/, "$1.$2.$3")
    //             numberCPFCNPJ = numberCPFCNPJ.replace(/\.(\d{3})(\d)/, ".$1/$2")
    //             numberCPFCNPJ = numberCPFCNPJ.replace(/(\d{4})(\d)/, "$1-$2")
    //           }
    //           //const token = await CheckSettingsHelper("OBTEM O TOKEN DO BANCO (dei insert na tabela settings)")
    //           const body = formatBody(`Aguarde! Estamos consultando na base de dados!`, contact)
    //           try {
    //             await sleep(2000)
    //             // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, body);
    //             await sendFaceMessage({ body: body, ticket });

    //           } catch (error) {
    //             //console.log('Não consegui enviar a mensagem!')
    //           }
    //           var options = {
    //             method: 'GET',
    //             url: `${urlixc}/webservice/v1/cliente`,
    //             headers: {
    //               ixcsoft: 'listar',
    //               Authorization: `Basic ${ixckeybase64}`
    //             },
    //             data: {
    //               qtype: 'cliente.cnpj_cpf',
    //               query: numberCPFCNPJ,
    //               oper: '=',
    //               page: '1',
    //               rp: '1',
    //               sortname: 'cliente.cnpj_cpf',
    //               sortorder: 'asc'
    //             }
    //           };

    //           axios.request(options as any).then(async function (response) {
    //             //console.log(response.data)
    //             if (response.data.type === 'error') {
    //               const body = formatBody(`*Opss!!!!*\nOcorreu um erro! Digite *#* e fale com um *Atendente*!`, contact)
    //               await sleep(2000)
    //               await sendFaceMessage({ body: body, ticket });

    //               // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, body);
    //             } if (response.data.total === 0) {
    //               const body = formatBody(`Cadastro não localizado! *CPF/CNPJ* incorreto ou inválido. Tenta novamente!`, contact);
    //               try {
    //                 await sleep(2000)
    //                 // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, body);
    //                 await sendFaceMessage({ body: body, ticket });

    //               } catch (error) {
    //                 //console.log('Não consegui enviar a mensagem!')
    //               }
    //             } else {

    //               let nome;
    //               let id;
    //               let type;

    //               nome = response.data?.registros[0]?.razao
    //               id = response.data?.registros[0]?.id
    //               type = response.data?.type


    //               const body = formatBody(`Localizei seu Cadastro! \n*${nome}* só mais um instante por favor!`, contact);
    //               await sleep(2000)
    //               await sendFaceMessage({ body: body, ticket });

    //               // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, body);
    //               ///VE SE ESTA BLOQUEADO PARA LIBERAR!
    //               var optionscontrato = {
    //                 method: 'POST',
    //                 url: `${urlixc}/webservice/v1/cliente_contrato`,
    //                 headers: {
    //                   ixcsoft: 'listar',
    //                   Authorization: `Basic ${ixckeybase64}`
    //                 },
    //                 data: {
    //                   qtype: 'cliente_contrato.id_cliente',
    //                   query: id,
    //                   oper: '=',
    //                   page: '1',
    //                   rp: '1',
    //                   sortname: 'cliente_contrato.id',
    //                   sortorder: 'asc'
    //                 }
    //               };
    //               axios.request(optionscontrato as any).then(async function (response) {
    //                 let status_internet;
    //                 let id_contrato;
    //                 status_internet = response.data?.registros[0]?.status_internet;
    //                 id_contrato = response.data?.registros[0]?.id;
    //                 if (status_internet !== 'A') {
    //                   const bodyPdf = formatBody(`*${nome}*  a sua conexão esta bloqueada! Vou desbloquear para você.`, contact)
    //                   await sleep(2000)
                      
    //                   // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyPdf);
    //                   await sendFaceMessage({ body: body, ticket });


    //                   const bodyqrcode = formatBody(`Estou liberando seu acesso. Por favor aguarde!`, contact)
    //                   await sleep(2000)

    //                   await sendFaceMessage({ body: bodyqrcode, ticket });

    //                   // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyqrcode);
    //                   //REALIZANDO O DESBLOQUEIO   
    //                   var optionsdesbloqeuio = {
    //                     method: 'POST',
    //                     url: `${urlixc}/webservice/v1/desbloqueio_confianca`,
    //                     headers: {
    //                       Authorization: `Basic ${ixckeybase64}`
    //                     },
    //                     data: { id: id_contrato }
    //                   };

    //                   axios.request(optionsdesbloqeuio as any).then(async function (response) {
    //                     let tipo;
    //                     let mensagem;
    //                     tipo = response.data?.tipo;
    //                     mensagem = response.data?.mensagem;
    //                     const body_mensagem = formatBody(`${mensagem}`, contact);
    //                     if (tipo === 'sucesso') {
    //                       //DESCONECTANDO O CLIENTE PARA VOLTAR O ACESSO
    //                       var optionsRadius = {
    //                         method: 'GET',
    //                         url: `${urlixc}/webservice/v1/radusuarios`,
    //                         headers: {
    //                           ixcsoft: 'listar',
    //                           Authorization: `Basic ${ixckeybase64}`
    //                         },
    //                         data: {
    //                           qtype: 'radusuarios.id_cliente',
    //                           query: id,
    //                           oper: '=',
    //                           page: '1',
    //                           rp: '1',
    //                           sortname: 'radusuarios.id',
    //                           sortorder: 'asc'
    //                         }
    //                       };

    //                       axios.request(optionsRadius as any).then(async function (response) {
    //                         let tipo;
    //                         tipo = response.data?.type;

    //                         if (tipo === 'success') {
    //                           await sleep(2000)
    //                           // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, body_mensagem);
                              
    //                           await sendFaceMessage({ body: body_mensagem, ticket });

    //                           const bodyPdf = formatBody(`Fiz os procedimentos de liberação! Agora aguarde até 5 minutos e veja se sua conexão irá retornar! .\n\nCaso não tenha voltado, retorne o contato e fale com um atendente!`, contact);
    //                           await sleep(2000)
    //                           await sendFaceMessage({ body: bodyPdf, ticket });

    //                           // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyPdf);
    //                           const bodyfinaliza = formatBody(`Estamos finalizando esta conversa! Caso precise entre em contato conosco!`, contact)
    //                           await sleep(2000)
    //                           await sendFaceMessage({ body: bodyfinaliza, ticket });

    //                           // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyfinaliza);
    //                           await UpdateTicketService({
    //                             ticketData: { status: "closed" },
    //                             ticketId: ticket.id,
    //                             companyId: ticket.companyId,
    //                           });
    //                         } else {
    //                           await sleep(2000)
    //                           // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, body_mensagem);
                             
    //                           await sendFaceMessage({ body: body_mensagem, ticket });

                             
    //                           const bodyPdf = formatBody(`Vou precisar que você *retire* seu equipamento da tomada.\n\n*OBS: Somente retire da tomada.* \nAguarde 1 minuto e ligue novamente!`, contact)
    //                           await sleep(2000)
    //                           // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyPdf);
                              
    //                           await sendFaceMessage({ body: bodyPdf, ticket });

    //                           const bodyqrcode = formatBody(`Veja se seu acesso voltou! Caso não tenha voltado retorne o contato e fale com um atendente!`, contact)
    //                           await sleep(2000)
    //                           // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyqrcode);
    //                           await sendFaceMessage({ body: bodyqrcode, ticket });

                              
    //                           const bodyfinaliza = formatBody(`Estamos finalizando esta conversa! Caso precise entre em contato conosco!`, contact)
    //                           await sleep(2000)
    //                           // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyfinaliza);
    //                           await sendFaceMessage({ body: bodyfinaliza, ticket });

    //                           await UpdateTicketService({
    //                             ticketData: { status: "closed" },
    //                             ticketId: ticket.id,
    //                             companyId: ticket.companyId,
    //                           });
    //                         }
    //                       }).catch(function (error) {
    //                         console.error(error);
    //                       });
    //                       //FIM DA DESCONEXÃO 

    //                     } else {
    //                       const bodyerro = formatBody(`Ops! Ocorreu um erro e nao consegui desbloquear!`, contact)
    //                       await sleep(2000)
    //                       // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyerro);
    //                       await sendFaceMessage({ body: bodyerro, ticket });

    //                       await sleep(2000)
    //                       // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, body_mensagem);
    //                       await sendFaceMessage({ body: body_mensagem, ticket });

    //                       const bodyerroatendente = formatBody(`Digite *#* e fale com um atendente!`, contact)
    //                       await sleep(2000)
    //                       // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyerroatendente);
                       
    //                       await sendFaceMessage({ body: bodyerroatendente, ticket });

    //                     } /* else {
    //                                const bodyerro = {
    //                 text: formatBody(`Ops! Ocorreu um erro e nao consegui desbloquear! Digite *#* e fale com um atendente!`
    //                                await sleep(2000)
    //                                await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`,bodyerro);  
    //                            } */

    //                   }).catch(async function (error) {
    //                     console.log('LINHA 738: ' + error)
    //                     const bodyerro = formatBody(`Ops! Ocorreu um erro digite *#* e fale com um atendente!`, contact)
    //                     await sleep(2000)
    //                     // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyerro);
    //                     await sendFaceMessage({ body: bodyerro, ticket });

    //                   });
    //                 } else {
    //                   const bodysembloqueio = formatBody(`Sua Conexão não está bloqueada! Caso esteja com dificuldades de navegação, retorne o contato e fale com um atendente!`, contact);
    //                   await sleep(2000)
    //                   // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodysembloqueio);
    //                   await sendFaceMessage({ body: bodysembloqueio, ticket });

    //                   const bodyfinaliza = formatBody(`Estamos finalizando esta conversa! Caso precise entre em contato conosco!`, contact)
    //                   await sleep(2000)
    //                   // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyfinaliza);
    //                   await sendFaceMessage({ body: bodyfinaliza, ticket });

    //                   await UpdateTicketService({
    //                     ticketData: { status: "closed" },
    //                     ticketId: ticket.id,
    //                     companyId: ticket.companyId,
    //                   });
    //                 }

    //                 //
    //               }).catch(async function (error) {
    //                 console.log('LINHA 746: ' + error)
    //                 const bodyerro = formatBody(`Ops! Ocorreu um erro digite *#* e fale com um atendente!`, contact)
    //                 await sleep(2000)
    //                 await sendFaceMessage({ body: bodyerro, ticket });

    //                 // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, bodyerro);
    //               });

    //             }

    //           }).catch(async function (error) {
    //             const body = formatBody(`*Opss!!!!*\nOcorreu um erro! Digite *#* e fale com um *Atendente*!`, contact)
    //             await sleep(2000)
    //             await sendFaceMessage({ body: body, ticket });

    //             // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, body);
    //           });
    //         } else {
    //           const body = formatBody(`Este CPF/CNPJ não é válido!\n\nPor favor tente novamente!\nOu digite *#* para voltar ao *Menu Anterior*`, contact)
    //           await sleep(2000)
    //           await sendFaceMessage({ body: body, ticket });

    //           // await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, body);
    //         }
    //       }
    //     }
    //   }
    // }

    // voltar para o menu inicial
    if (message == "#") {
      await ticket.update({
        queueOptionId: null,
        chatbot: false,
        queueId: null,
      });
      console.log(`entrou aqui`)
      return;
    }


      const ticketTraking = await FindOrCreateATicketTrakingService({
        ticketId: ticket.id,
        companyId,
        whatsappId: getSession?.id,
      });
      
      try {
        if (!fromMe) {
          if (ticketTraking !== null && verifyRating(ticketTraking)) {
            handleRating(message, ticket, ticketTraking);
            return;
          }
        }
      } catch (e) {
        console.log(e);
      }
  
      if (!ticket.queue && !fromMe && !ticket.userId && getSession?.queues?.length >= 1) {
        await verifyQueue(getSession, message, ticket, ticket.contact);
      }

      const dontReadTheFirstQuestion = ticket.queue === null;
  
      await ticket.reload();
  
      if (getSession?.queues?.length == 1 && ticket.queue) {
        if (ticket.chatbot && !fromMe) {
          // await handleChartbot(ticket, msg, wbot);
        }
      }

      // if (whatsapp.queues.length > 1 && ticket.queue) {
      //   if (ticket.chatbot && !msg.key.fromMe) {
      //     await handleChartbot(ticket, msg, wbot, dontReadTheFirstQuestion);
      //   }
      // }

  }
 
};
