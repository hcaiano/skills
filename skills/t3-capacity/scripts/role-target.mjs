import { chooseCandidate, rankCandidates } from './capacity-choice.mjs';

const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export const parseRole = (text, role) => {
  let effort = 'xhigh';
  let value = null;
  for (const line of text.split(/\r?\n/u)) {
    const budget = line.match(/^\s*#\s*effort\s+(\w+):\s*(.+)$/u);
    if (budget) {
      if (!efforts.includes(budget[1])) throw new Error(`unknown effort ${budget[1]}`);
      if (budget[2].split(',').map((name) => name.trim()).includes(role)) effort = budget[1];
    }
    if (/^\s*#/u.test(line)) continue;
    const at = line.indexOf(':');
    if (at > 0 && line.slice(0, at).split(',').map((name) => name.trim()).includes(role)) {
      if (value != null) throw new Error(`duplicate role ${role}`);
      value = line.slice(at + 1).trim();
    }
  }
  if (value == null) return { effort, seats: [], reason: `unknown role ${role}` };
  const entries = value.split(',');
  const seats = entries.map((entry) => {
    const match = entry.trim().match(/^capacity\[([^\]]+)\]$/u);
    if (!match) throw new Error(`role ${role} needs capacity[...] entries, got ${entry.trim()}`);
    return match[1].split('>').map((tier) => tier.split('|').map((model) => {
      const id = model.trim();
      if (!id || /[\s,[\]]/u.test(id)) throw new Error(`invalid model in role ${role}`);
      return id;
    }));
  });
  return { effort, seats };
};

const effortOption = (model, effort) => {
  const options = (model.options ?? []).filter((option) => /reasoning|effort/iu.test(`${option.id} ${option.label ?? ''}`)
    && Array.isArray(option.options));
  if (options.length !== 1) return null;
  const option = options[0];
  const supported = option.options.map(({ id }) => id);
  const value = efforts.slice(0, efforts.indexOf(effort) + 1).reverse().find((id) => supported.includes(id));
  return value ? { id: option.id, value } : null;
};

export const resolveRole = (config, capabilities, mapped, accounts) => {
  if (config.reason) return [{ seat: 0, candidates: [], choice: null, target: null, reason: config.reason }];
  return config.seats.map((seat, index) => {
    const rejected = [];
    const targets = new Map();
    const tiers = seat.map((models) => models.flatMap((id) => {
      const serving = capabilities.providers.filter((provider) => provider.models.some((model) => model.id === id));
      if (!serving.length) rejected.push({ model: id, reason: 'model missing from catalog' });
      return serving.flatMap((provider) => {
        const instance = provider.providerInstanceId;
        const model = provider.models.find((entry) => entry.id === id);
        const option = effortOption(model, config.effort);
        const reason = provider.canRunChildTask === false ? 'provider cannot run child tasks'
          : !option ? `no unambiguous reasoning option at or below ${config.effort}` : null;
        if (reason) { rejected.push({ instance, model: id, reason }); return []; }
        targets.set(`${instance}/${id}`, { providerInstanceId: instance, model: id, options: [option] });
        return [{ instance, model: id }];
      });
    }));
    const ranked = rankCandidates(tiers, mapped, accounts);
    const choice = chooseCandidate(ranked);
    return { seat: index, effort: config.effort, candidates: ranked.flat(), rejected, choice,
      target: choice ? targets.get(`${choice.instance}/${choice.model}`) : null,
      ...(choice ? {} : { reason: tiers.flat().length ? 'no candidate has known available or protected capacity'
        : 'no catalog candidate supports the role and effort' }) };
  });
};
