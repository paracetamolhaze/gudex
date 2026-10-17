import { useTranslation } from 'react-i18next';
import { RefreshControl, View } from 'react-native';
import type { ActivityItemDto } from '@gudex/shared';
import { ActivityRow } from '../../../components/ActivityRow';
import { AppText, Loading, Screen, Surface } from '../../../components/ui';
import { useFormat } from '../../../lib/format';
import { useActivity } from '../../../lib/queries';
import { space, useColors } from '../../../theme';

function groupByDay(items: ActivityItemDto[], formatDay: (iso: string) => string) {
  const groups: { day: string; items: ActivityItemDto[] }[] = [];
  for (const item of items) {
    const day = formatDay(item.createdAt);
    const last = groups[groups.length - 1];
    if (last?.day === day) last.items.push(item);
    else groups.push({ day, items: [item] });
  }
  return groups;
}

export default function History() {
  const fmt = useFormat();
  const { t } = useTranslation();
  const c = useColors();
  const activity = useActivity(100);

  return (
    <Screen refreshControl={<RefreshControl refreshing={activity.isRefetching} onRefresh={() => activity.refetch()} tintColor={c.primary} />}>
      <AppText variant="title">{t('history.title')}</AppText>
      {activity.isLoading ? (
        <Loading />
      ) : activity.data?.length ? (
        groupByDay(activity.data, fmt.day).map((group) => (
          <View key={group.day} style={{ gap: space.sm }}>
            <AppText variant="label" muted>
              {group.day}
            </AppText>
            <Surface>
              {group.items.map((item) => (
                <ActivityRow key={item.id} item={item} />
              ))}
            </Surface>
          </View>
        ))
      ) : (
        <Surface>
          <AppText muted>{t('history.empty')}</AppText>
        </Surface>
      )}
    </Screen>
  );
}
