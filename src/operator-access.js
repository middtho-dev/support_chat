'use strict';
function operatorView(operator,owners){
 const protectedOwner=owners.has(String(operator.telegram_user_id));
 return {telegramUserId:operator.telegram_user_id,displayName:operator.display_name,username:operator.username||'',
  active:protectedOwner||!!operator.active,canManageSettings:protectedOwner||!!operator.can_manage_settings,
  protected:protectedOwner,lastSeenAt:operator.last_seen_at||null};
}
function protectedChange(operator,owners){
 return owners.has(String(operator.telegramUserId))&&(!operator.active||!operator.canManageSettings);
}
module.exports={operatorView,protectedChange};
