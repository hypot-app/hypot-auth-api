import { Command, CommandRunner } from 'nest-commander';
import { CreateAppCommand } from './create-app.command';
import { DeactivateAppCommand } from './deactivate-app.command';
import { UpdateAppCommand } from './update-app.command';

@Command({
  name: 'app',
  description: 'Manage client apps (operator only)',
  subCommands: [CreateAppCommand, UpdateAppCommand, DeactivateAppCommand],
})
export class AppCommand extends CommandRunner {
  async run(): Promise<void> {
    this.command.outputHelp();
  }
}
