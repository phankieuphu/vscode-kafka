import * as vscode from "vscode";
import { Kafka } from "kafkajs";

let kafka: Kafka | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const connectCommand = vscode.commands.registerCommand(
    "kafka-manager.connect",
    async () => {
      const brokers = await vscode.window.showInputBox({
        prompt: "Enter Kafka Brokers (comma-separated)",
        placeHolder: "localhost:9092",
      });

      if (!brokers) return;

      kafka = await new Kafka({ brokers: brokers.split(",") });
      vscode.window.showInformationMessage(
        `Connected to Kafka brokers: ${brokers}`
      );
    }
  );

  const listTopicsCommand = vscode.commands.registerCommand(
    "kafka-manager.listTopics",
    async () => {
      if (!kafka) {
        vscode.window.showErrorMessage(
          "Please connect to a Kafka cluster first."
        );
        return;
      }

      try {
        const admin = kafka.admin();
        await admin.connect();
        const topics = await admin.listTopics();
        await admin.disconnect();

        if (topics.length > 0) {
          vscode.window.showInformationMessage(`Topics: ${topics.join(", ")}`);
        } else {
          vscode.window.showInformationMessage("No topics found.");
        }
      } catch (error: any) {
        vscode.window.showErrorMessage(
          `Error listing topics: ${error.message}`
        );
      }
    }
  );

  const createTopicCommand = vscode.commands.registerCommand(
    "kafka-manager.createTopic",
    async () => {
      if (!kafka) {
        vscode.window.showErrorMessage(
          "Please connect to a Kafka cluster first."
        );
        return;
      }

      const topic = await vscode.window.showInputBox({
        prompt: "Enter the name of the topic to create",
      });

      if (!topic) return;

      try {
        const admin = kafka.admin();
        await admin.connect();
        await admin.createTopics({
          topics: [{ topic }],
        });
        await admin.disconnect();

        vscode.window.showInformationMessage(
          `Topic "${topic}" created successfully.`
        );
      } catch (error: any) {
        vscode.window.showErrorMessage(
          `Error creating topic: ${error.message}`
        );
      }
    }
  );

  const produceMessageCommand = vscode.commands.registerCommand(
    "kafka-manager.produceMessage",
    async () => {
      if (!kafka) {
        vscode.window.showErrorMessage(
          "Please connect to a Kafka cluster first."
        );
        return;
      }

      const topic = await vscode.window.showInputBox({
        prompt: "Enter the topic to produce a message to",
      });

      if (!topic) return;

      const message = await vscode.window.showInputBox({
        prompt: `Enter the message to produce to topic "${topic}"`,
      });

      if (!message) return;

      try {
        const producer = kafka.producer();
        await producer.connect();
        await producer.send({
          topic,
          messages: [{ value: message }],
        });
        await producer.disconnect();

        vscode.window.showInformationMessage(
          `Message sent to topic "${topic}".`
        );
      } catch (error: any) {
        vscode.window.showErrorMessage(
          `Error producing message: ${error.message}`
        );
      }
    }
  );

  const consumeMessagesCommand = vscode.commands.registerCommand(
    "kafka-manager.consumeMessages",
    async () => {
      if (!kafka) {
        vscode.window.showErrorMessage(
          "Please connect to a Kafka cluster first."
        );
        return;
      }

      const topic = await vscode.window.showInputBox({
        prompt: "Enter the topic to consume messages from",
      });

      if (!topic) return;

      try {
        const consumer = kafka.consumer({ groupId: "kafka-manager-group" });
        await consumer.connect();
        await consumer.subscribe({ topic, fromBeginning: true });

        consumer.run({
          eachMessage: async ({ message }) => {
            vscode.window.showInformationMessage(
              `Received message: ${message.value?.toString()}`
            );
          },
        });

        vscode.window.showInformationMessage(
          `Consuming messages from topic "${topic}"...`
        );
      } catch (error: any) {
        vscode.window.showErrorMessage(
          `Error consuming messages: ${error.message}`
        );
      }
    }
  );

  context.subscriptions.push(
    connectCommand,
    listTopicsCommand,
    createTopicCommand,
    produceMessageCommand,
    consumeMessagesCommand
  );
}

export function deactivate() {
  // KafkaJS automatically cleans up connections when the process exits.
}
